import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
import express from 'express';
import {Contract,Interface,JsonRpcProvider,ZeroAddress,getAddress,keccak256} from 'ethers';
import {z} from 'zod';
import {config,readJSON} from './config.ts';
import {Store} from './store.ts';
import {ReadRpc,TRANSFER_TOPIC,hex} from './rpc.ts';
import {classifyFlow,flowMetrics} from './flow-metrics.ts';
import {runFlowStage} from './flow-agent.ts';
import type {FlowDeployment,FlowEvent,FlowJob,FlowOverview,FlowReport,FlowRole,FlowStage} from '../shared/flow.ts';

const same=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
const eventOrder=(a:FlowEvent,b:FlowEvent)=>a.blockNumber-b.blockNumber||a.logIndex-b.logIndex;
const inputSchema=z.object({role:z.enum(['merchant','userA','userB']),amount:z.string().regex(/^[1-9]\d{0,29}$/),to:z.string(),requestId:z.uuid()}).strict();
export class FlowService{
  store=new Store('data/direct-flow.sqlite');syncing:Promise<void>|undefined;busy=false;closing=false;lastError='';
  constructor(){
    for(const job of this.store.list<FlowJob>('jobs'))if(['investigating','reviewing'].includes(job.status))this.store.put('jobs',{...job,status:'partial',error:'服务重启中断调查，请重新核查。'});
  }
  deployment():FlowDeployment{
    const publicMode=process.env.FLOW_NETWORK==='sepolia',file='data/flow/deployment-'+(publicMode?'sepolia':'local')+'.json';
    if(!fs.existsSync(file))throw new Error(publicMode?'Sepolia 尚未部署；本地流程可先运行。':'本地流程尚未初始化，请运行 npm run start。');
    const d=readJSON<FlowDeployment>(file);if(d.chainId!==(publicMode?11155111:31337))throw new Error('部署网络不匹配');
    getAddress(d.token);for(const a of Object.values(d.accounts))getAddress(a);return d;
  }
  rpc(d:FlowDeployment){return d.chainId===31337?config.localRpc:config.sepoliaRpc;}
  events(d:FlowDeployment):FlowEvent[]{return this.store.events(d.id).map(e=>({id:e.id,txHash:e.txHash,logIndex:e.logIndex,blockNumber:e.blockNumber,blockHash:e.blockHash,timestamp:e.timestamp,from:e.args.from,to:e.args.to,amount:e.args.amount,kind:e.name as FlowEvent['kind']}));}
  readRpc(d:FlowDeployment){return new ReadRpc(this.rpc(d),600,AbortSignal.timeout(30000));}
  sync(){if(this.syncing)return this.syncing;this.syncing=this.syncInner().finally(()=>{this.syncing=undefined;});return this.syncing;}
  async syncInner(){
    const d=this.deployment(),rpc=this.readRpc(d),abi=readJSON('shared/artifacts/GymToken.json');
    if(Number(BigInt(await rpc.call('eth_chainId',[])))!==d.chainId)throw new Error('RPC 实际网络不匹配');
    const code=await rpc.call('eth_getCode',[d.token,'latest']);if(code==='0x'||keccak256(code)!==keccak256(abi.deployedBytecode))throw new Error('当前链合约与部署记录不匹配，不能展示旧余额');
    const deploymentReceipt=await rpc.call('eth_getTransactionReceipt',[d.deploymentHash]);if(deploymentReceipt.status!=='0x1'||!same(deploymentReceipt.contractAddress,d.token))throw new Error('部署收据无效');
    const head=await rpc.block('latest'),old=this.store.checkpoint(d.id);
    if(old?.blockNumber>head.number||old?.blockHash&&(await rpc.block(old.blockNumber)).hash!==old.blockHash){
      this.store.rollback(d.id,d.deploymentBlock-1);
      for(const j of this.store.list<FlowJob>('jobs',d.id))this.store.put('jobs',{...j,status:'stale',error:'链历史变化，旧调查失效。'});
    }
    const cp=this.store.checkpoint(d.id),from=Math.max(d.deploymentBlock,(cp?.blockNumber??d.deploymentBlock-1)+1);
    if(head.number-d.deploymentBlock>20000)throw new Error('超出轻量演示索引范围，需配置长期索引器');
    const logs=from<=head.number?await rpc.logs(d.token,from,head.number,[TRANSFER_TOPIC],2000):[];
    const iface=new Interface(abi.abi),known=this.events(d),pending:FlowEvent[]=[];
    const firstRecipients=new Set(known.filter(e=>e.kind==='withdrawal').map(e=>e.to.toLowerCase()));
    for(const log of logs.sort((a,b)=>Number(BigInt(a.blockNumber))-Number(BigInt(b.blockNumber))||Number(BigInt(a.logIndex))-Number(BigInt(b.logIndex)))){
      const parsed=iface.parseLog(log);if(!parsed||same(parsed.args.from,ZeroAddress))continue;
      const fromAddress=getAddress(parsed.args.from),toAddress=getAddress(parsed.args.to);
      const primary=[d.accounts.merchant,d.accounts.userA,d.accounts.userB].some(a=>same(a,fromAddress)||same(a,toAddress));
      if(!primary&&!firstRecipients.has(fromAddress.toLowerCase()))continue;
      if(same(fromAddress,d.accounts.merchant))firstRecipients.add(toAddress.toLowerCase());
      const block=await rpc.block(Number(BigInt(log.blockNumber)));
      const event:FlowEvent={id:`${d.id}:${log.transactionHash}:${Number(BigInt(log.logIndex))}`,txHash:log.transactionHash,logIndex:Number(BigInt(log.logIndex)),blockNumber:block.number,blockHash:block.hash,timestamp:block.timestamp,from:fromAddress,to:toAddress,amount:parsed.args.value.toString(),kind:classifyFlow(d,fromAddress,toAddress)};
      pending.push(event);
    }
    this.store.transaction(()=>{
      for(const e of pending){this.store.addEvent({id:e.id,datasetId:d.id,chainId:d.chainId,address:d.token,name:e.kind,args:{from:e.from,to:e.to,amount:e.amount},txHash:e.txHash,blockNumber:e.blockNumber,blockHash:e.blockHash,timestamp:e.timestamp,transactionIndex:0,logIndex:e.logIndex,finality:'confirmed'});this.store.block(d.id,e.blockNumber,e.blockHash);}
      this.store.checkpointPut(d.id,{blockNumber:head.number,blockHash:head.hash,timestamp:head.timestamp,coverageComplete:true});
    });
    this.lastError='';
    if(config.autoInvestigation)for(const event of pending)this.start(event.id,'核查这笔资金变动的原因、影响、正常解释与证据缺口。',true);
    void this.drain();
  }
  async overview():Promise<FlowOverview>{
    const base={version:'direct-flow-v1' as const,modelConfigured:!!config.llmKey&&config.llmEnabled,automaticAnalysis:config.autoInvestigation,events:[],jobs:[],reports:[],totalEvents:0,signingEnabled:false};
    let d:FlowDeployment;try{d=this.deployment();}catch(error){return {...base,ready:false,error:(error as Error).message};}
    try{
      await this.sync();const p=new JsonRpcProvider(this.rpc(d),d.chainId,{staticNetwork:true,cacheTimeout:-1});
      let balances:Record<FlowRole,string>;try{const token=new Contract(d.token,readJSON('shared/artifacts/GymToken.json').abi,p);balances=Object.fromEntries(await Promise.all(Object.entries(d.accounts).map(async([r,a])=>[r,(await token.balanceOf(a)).toString()]))) as Record<FlowRole,string>;}finally{p.destroy();}
      const events=this.events(d);return {...base,ready:true,deployment:d,balances,checkpoint:this.store.checkpoint(d.id),events:events.slice(-100),totalEvents:events.length,jobs:this.store.list<FlowJob>('jobs',d.id).slice(0,100),reports:this.store.list<FlowReport>('reports',d.id).slice(0,100),signingEnabled:d.chainId===31337,monitorError:this.lastError||undefined};
    }catch{this.lastError='链上连接或部署核验失败，历史记录不是最新余额。';return {...base,ready:false,deployment:d,error:this.lastError,events:this.events(d).slice(-100),jobs:this.store.list<FlowJob>('jobs',d.id).slice(0,100),reports:this.store.list<FlowReport>('reports',d.id).slice(0,100),totalEvents:this.events(d).length};}
  }
  async transfer(raw:unknown){
    const input=inputSchema.parse(raw),d=this.deployment();
    if(d.chainId!==31337)throw new Error('公开网络目前仅查询；公开签名与部署尚未授权配置');
    const rpcUrl=new URL(config.localRpc);if(rpcUrl.protocol!=='http:'||!['127.0.0.1','localhost'].includes(rpcUrl.hostname))throw new Error('本地测试签名仅限回环网络');
    const to=getAddress(input.to.trim()),from=d.accounts[input.role],n=BigInt(input.amount);
    if(to===ZeroAddress||same(to,from))throw new Error('不能转给零地址或自己');
    if(input.role!=='merchant'&&!same(to,d.accounts.merchant))throw new Error('会员付款目标必须为当前商家');
    const requestKey=d.id+':request:'+input.requestId,existing=this.store.get('evidence',requestKey);
    if(existing){if(JSON.stringify(existing.input)!==JSON.stringify(input))throw new Error('重复请求编号不能用于不同付款');if(existing.txHash)return {txHash:existing.txHash,confirmed:existing.confirmed===true,reused:true};throw new Error('相同请求正在处理，不要重复提交');}
    this.store.put('evidence',{id:requestKey,datasetId:d.id,input,confirmed:false});
    const p=new JsonRpcProvider(config.localRpc,31337,{staticNetwork:true,cacheTimeout:-1});let submitted=false;
    try{
      if(Number(await p.send('eth_chainId',[]))!==31337)throw new Error('测试网络不匹配');
      await this.sync();const signer=await p.getSigner(from),token=new Contract(d.token,readJSON('shared/artifacts/GymToken.json').abi,signer);
      if(await token.balanceOf(from)<n)throw new Error('健身币余额不足');
      const tx=await token.transfer(to,n);submitted=true;this.store.put('evidence',{id:requestKey,datasetId:d.id,input,confirmed:false,txHash:tx.hash});
      const receipt=await tx.wait(1,60000);if(receipt?.status!==1)throw new Error('链上交易未成功');
      this.store.put('evidence',{id:requestKey,datasetId:d.id,input,confirmed:true,txHash:tx.hash});
      try{await this.sync();}catch{this.lastError='交易已确认，但索引同步未完成；不要重复付款。';}
      return {txHash:tx.hash,confirmed:true};
    }catch(error){if(!submitted)this.store.db.prepare('DELETE FROM evidence WHERE id=?').run(requestKey);throw error;}finally{p.destroy();}
  }
  start(eventId:string,question:string,automatic=false){
    const d=this.deployment(),event=this.events(d).find(e=>e.id===eventId);if(!event)throw new Error('事件不在当前范围内');
    const existing=this.store.list<FlowJob>('jobs',d.id).find(j=>j.eventId===eventId&&(automatic||['queued','investigating','reviewing'].includes(j.status))&&j.status!=='stale');if(existing)return existing;
    const cp=this.store.checkpoint(d.id);if(!cp?.coverageComplete)throw new Error('事件索引不完整');
    const job:FlowJob={id:randomUUID(),datasetId:d.id,eventId,question,status:'queued',createdAt:new Date().toISOString(),asOfBlock:cp.blockNumber,stages:[]};this.store.put('jobs',job);void this.drain();return job;
  }
  async drain(){
    if(this.busy||this.closing)return;
    const d=(()=>{try{return this.deployment();}catch{return undefined;}})();if(!d)return;
    const job=this.store.list<FlowJob>('jobs',d.id).reverse().find(j=>j.status==='queued');if(!job)return;
    const event=this.events(d).find(e=>e.id===job.eventId);if(!event)return;
    this.busy=true;
    try{await this.investigate(d,event,job);}catch{this.store.put('jobs',{...job,status:'partial',error:'调查流程未完成，可重新核查。'});}finally{this.busy=false;if(!this.closing)queueMicrotask(()=>void this.drain());}
  }
  async investigate(d:FlowDeployment,event:FlowEvent,job:FlowJob){
    const events=this.events(d).filter(e=>e.blockNumber<=job.asOfBlock).sort(eventOrder),window=events.filter(e=>eventOrder(e,event)<=0),ids=()=>window.map(e=>e.id),metricsId=job.id+':metrics',receiptId=job.id+':receipt';
    const execute=async(name:string,raw:any)=>{
      if(name==='list_events')return {data:{events:window.slice(-60),total:window.length,truncated:window.length>60,asOfBlock:job.asOfBlock,limitation:'一笔付款同时是商家收款，不重复计数。初始铸币不是经营收款。'},evidenceIds:ids()};
      if(name==='compute_metrics')return {data:{...flowMetrics(d,events,event),evidenceId:metricsId,formula:{bps:'分子×10000÷分母；10000bps=100%，整数截断',amountRatio:'当前金额÷此前最多20笔同类记录中位数，仅样本>=3时计算',outflowRatio:'24小时商家转出合计÷商家收款合计',concentration:'24小时最大接收方转出合计÷转出合计'},asOfBlock:event.blockNumber},evidenceIds:[metricsId]};
      if(name==='verify_transaction'){
        const chosen=window.find(e=>same(e.txHash,raw.txHash));if(!chosen)throw new Error('查询超出范围');
        const rpc=this.readRpc(d),tx=await rpc.call('eth_getTransactionByHash',[chosen.txHash]),receipt=await rpc.call('eth_getTransactionReceipt',[chosen.txHash]),block=await rpc.block(chosen.blockNumber);
        const iface=new Interface(readJSON('shared/artifacts/GymToken.json').abi),log=receipt.logs.find((l:any)=>Number(BigInt(l.logIndex))===chosen.logIndex&&same(l.address,d.token));
        const decoded=log?iface.parseLog(log):null;
        if(receipt.status!=='0x1'||receipt.blockHash!==chosen.blockHash||block.hash!==chosen.blockHash||!decoded||!same(decoded.args.from,chosen.from)||!same(decoded.args.to,chosen.to)||decoded.args.value.toString()!==chosen.amount)throw new Error('收据与事件不匹配');
        const id=chosen.id===event.id?receiptId:job.id+':receipt:'+chosen.id;
        return {data:{evidenceId:id,chainId:d.chainId,txHash:chosen.txHash,blockNumber:chosen.blockNumber,blockHash:block.hash,status:'confirmed',transactionFrom:tx.from,transactionTo:tx.to,transfer:{from:chosen.from,to:chosen.to,amount:chosen.amount,logIndex:chosen.logIndex},gasUsed:BigInt(receipt.gasUsed).toString(),effectiveGasPrice:BigInt(receipt.effectiveGasPrice).toString(),explorerUrl:d.chainId===11155111?'https://sepolia.etherscan.io/tx/'+chosen.txHash:null,finality:'已入块；不是最终不可逆确认'},evidenceIds:[id,chosen.id]};
      }
      if(name==='trace_recipient'){
        const anchors=window.filter(e=>e.kind==='withdrawal'&&same(e.to,raw.address));if(!anchors.length)throw new Error('不是商家直接接收地址');
        const anchor=anchors.at(-1)!,toBlock=Math.min(job.asOfBlock,anchor.blockNumber+120),rpc=this.readRpc(d);
        const logs=await rpc.logs(d.token,anchor.blockNumber,toBlock,[TRANSFER_TOPIC],1000),iface=new Interface(readJSON('shared/artifacts/GymToken.json').abi),matches:unknown[]=[];
        for(const log of logs){if(Number(BigInt(log.blockNumber))===anchor.blockNumber&&Number(BigInt(log.logIndex))<=anchor.logIndex)continue;const p=iface.parseLog(log);if(p&&same(p.args.from,raw.address)){if(matches.length>=20)throw new Error('追踪超过轻量证据预算');const receipt=await rpc.call('eth_getTransactionReceipt',[log.transactionHash]),canonical=await rpc.block(Number(BigInt(log.blockNumber))),matching=receipt.logs.find((l:any)=>same(l.address,d.token)&&l.logIndex===log.logIndex),decoded=matching?iface.parseLog(matching):null;if(receipt.status!=='0x1'||receipt.blockHash!==log.blockHash||canonical.hash!==log.blockHash||!decoded||decoded.args.value!==p.args.value||!same(decoded.args.from,p.args.from)||!same(decoded.args.to,p.args.to))throw new Error('关联收据不匹配');matches.push({txHash:log.transactionHash,blockNumber:Number(BigInt(log.blockNumber)),from:p.args.from,to:p.args.to,amount:p.args.value.toString()});}}
        const id=job.id+':trace:'+raw.address.toLowerCase();return {data:{evidenceId:id,address:raw.address,anchorEventId:anchor.id,fromBlock:anchor.blockNumber,toBlock,transfers:matches,completeWithinWindow:true,limitation:'仅一层、当前币种和最多120区块；未查询下一接收地址，不能证明这些转出属于该笔会员款，未来交易不在本次报告中。'},evidenceIds:[id,anchor.id]};
      }
      throw new Error('只读工具不存在');
    };
    this.store.put('evidence',{id:metricsId,datasetId:d.id,kind:'deterministic-metrics',eventId:event.id,asOfBlock:event.blockNumber,metrics:flowMetrics(d,events,event),sourceEventIds:ids()});
    const publish=(s:FlowStage)=>{if(this.store.get<FlowJob>('jobs',job.id)?.status==='stale')return;job.stages=[...job.stages.filter(x=>x.name!==s.name),structuredClone(s)];job.status=s.name==='investigator'?'investigating':'reviewing';this.store.put('jobs',job);};
    const investigator=await runFlowStage('investigator',d,event,job.question,execute,publish);
    const reviewer=investigator.status==='complete'?await runFlowStage('reviewer',d,event,job.question,execute,publish,investigator):undefined;
    const complete=investigator.status==='complete'&&reviewer?.status==='complete';
    const disputed=complete&&(reviewer.result?.verdict==='disagree'||reviewer.result?.risk!==investigator.result?.risk);
    const metrics=flowMetrics(d,events,event),report:FlowReport={id:randomUUID(),datasetId:d.id,eventId:event.id,asOfBlock:job.asOfBlock,chainId:d.chainId,dataOrigin:d.dataOrigin,status:complete?'complete':'partial',risk:!complete?'insufficient':disputed?'disputed':reviewer.result?.verdict==='insufficient'?'insufficient':reviewer.result!.risk,headline:!complete?'AI 核查未完成':disputed?'两位 Agent 判断不同，待核实':reviewer.result!.summary,metrics,facts:[{text:`本笔转账 ${event.amount} GYM，发送方 ${event.from}，接收方 ${event.to}。`,evidenceIds:[event.id]},{text:`统计窗口收款 ${metrics.receipts} GYM，转出 ${metrics.outflows} GYM；只计算一次付款，不重复计收款。`,evidenceIds:[metricsId]}],stages:job.stages,limitations:[...metrics.limitations,'仅分析已观察到的链上资金行为，不评价未知线下履约；GYM 为无真实价值的测试币。','调查与复核使用同一模型服务，独立调用工具不等于独立模型或完全消除共同偏差。'],generatedAt:new Date().toISOString()};
    const canonical=await this.readRpc(d).block(event.blockNumber);
    if(canonical.hash!==event.blockHash||this.store.get<FlowJob>('jobs',job.id)?.status==='stale'){job.status='stale';job.error='链历史变化，本次调查不可作为当前结论。';this.store.put('jobs',job);return;}
    this.store.put('reports',report);job.status=complete?'complete':'partial';job.reportId=report.id;job.error=complete?undefined:job.stages.find(s=>s.status==='failed')?.error;this.store.put('jobs',job);
  }
  close(){this.closing=true;/* Running jobs finish on this connection; process shutdown closes SQLite. */}
}
export function mountFlow(app:express.Express){
  const service=new FlowService();
  const route=(fn:(req:express.Request)=>unknown|Promise<unknown>)=>(req:express.Request,res:express.Response)=>Promise.resolve().then(()=>fn(req)).then(data=>res.json({data})).catch(error=>{
    const message=error instanceof z.ZodError?'请输入有效的正整数金额、地址和请求编号。':error instanceof Error?error.message:'';
    const safe=/^(健身币余额不足|会员付款目标|不能转给|相同请求|重复请求|本地流程|Sepolia 尚未|公开网络目前|事件不在|事件索引)/.test(message)?message:'操作未完成，请检查本地链或参数；如果已发出交易，请先查看账单，不要重复付款。';res.status(400).json({error:{message:safe}});
  });
  app.get('/api/flow',route(()=>service.overview()));
  app.post('/api/flow/transfers',route(req=>service.transfer(req.body)));
  app.post('/api/flow/investigations',route(req=>{const p=z.object({eventId:z.string().min(1).max(250),question:z.string().min(1).max(1000)}).strict().parse(req.body);return service.start(p.eventId,p.question);}));
  app.get('/api/flow/jobs/:id',route(req=>service.store.get('jobs',String(req.params.id))??null));
  app.get('/api/flow/reports/:id',route(req=>service.store.get('reports',String(req.params.id))??null));
  const timer=setInterval(()=>void service.sync().catch(()=>{service.lastError='同步未完成，不能把历史记录当作最新结果。';}),5000);timer.unref();
  return ()=>{clearInterval(timer);service.close();};
}
