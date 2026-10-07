import {Contract,Interface,JsonRpcProvider} from 'ethers';
import {config,readJSON} from './config.ts';
import {Store} from './store.ts';
import {stableId,gymAlerts} from './rules.ts';
import type {Dataset,ChainEvent,Evidence} from '../shared/types.ts';
import {TRANSFER_TOPIC,addressTopic,ReadRpc} from './rpc.ts';
import {indexedTransfers} from './blockscout.ts';
import {followupScope} from './followup.ts';
export const tokenAbi=['event Transfer(address indexed from,address indexed to,uint256 value)','function balanceOf(address) view returns(uint256)','function decimals() view returns(uint8)','function symbol() view returns(string)'];
export function providerFor(ds:Dataset){const url=ds.chainId===31337?config.localRpc:ds.chainId===11155111?config.sepoliaRpc:ds.chainId===1?config.mainnetRpc:null;if(!url)throw new Error('Unsupported network');return new JsonRpcProvider(url,ds.chainId,{staticNetwork:true,cacheTimeout:-1});}
export function explorer(ds:Dataset,hash:string){return ds.chainId===1?'https://etherscan.io/tx/'+hash:ds.chainId===11155111?'https://sepolia.etherscan.io/tx/'+hash:undefined;}
export class ChainService {
  store:Store;busy=new Set<string>();
  constructor(store:Store){this.store=store;}
  async sync(ds:Dataset){
    if(this.busy.has(ds.id))return this.store.checkpoint(ds.id);this.busy.add(ds.id);
    const provider=providerFor(ds);
    try {
      const actual=Number(await provider.send('eth_chainId',[]));if(actual!==ds.chainId)throw new Error('Network mismatch');
      const head=await provider.getBlockNumber(),end=Math.min(head,ds.toBlock??head),cp=this.store.checkpoint(ds.id);
      let finalizedBlock:number|undefined;
      if(ds.chainId!==31337){try{finalizedBlock=(await provider.getBlock('finalized'))?.number;}catch{/* Unsupported finalized tag remains explicitly unknown. */}}
      if(cp?.blockNumber&&cp.blockHash){const old=await provider.getBlock(cp.blockNumber);
        if(!old||old.hash!==cp.blockHash){let ancestor=ds.deploymentBlock-1;const blocks=this.store.db.prepare('SELECT number,hash FROM blocks WHERE dataset=? ORDER BY number DESC LIMIT 64').all(ds.id) as {number:number;hash:string}[];
          for(const b of blocks){const now=await provider.getBlock(b.number);if(now?.hash===b.hash){ancestor=b.number;break;}}
          this.store.rollback(ds.id,ancestor);
        }
      }
      const cursor=this.store.checkpoint(ds.id);let start=Math.max(ds.deploymentBlock,ds.fromBlock??0,(cursor?.blockNumber??-1)+1);
      const escrowInterface=ds.adapter==='gym'?new Interface(readJSON('shared/artifacts/GymEscrow.json').abi):null,tokenInterface=new Interface(tokenAbi);
      const batch:ChainEvent[]=[];const blockCache=new Map<number,any>();
      let chunk=5000;
      while(start<=end){const stop=Math.min(start+chunk-1,end);let logs;
        try{if(ds.adapter==='erc20'){if(!ds.target)throw new Error('Target address required');const topic=addressTopic(ds.target);const [outgoing,incoming]=await Promise.all([provider.getLogs({address:ds.token,fromBlock:start,toBlock:stop,topics:[TRANSFER_TOPIC,topic]}),provider.getLogs({address:ds.token,fromBlock:start,toBlock:stop,topics:[TRANSFER_TOPIC,null,topic]})]);logs=Array.from(new Map([...outgoing,...incoming].map(l=>[l.transactionHash+':'+l.index,l])).values()).sort((a,b)=>a.blockNumber-b.blockNumber||a.index-b.index);}else logs=await provider.getLogs({address:ds.escrow?[ds.escrow,ds.token]:ds.token,fromBlock:start,toBlock:stop});}
        catch(error){if(chunk>100){chunk=Math.max(100,Math.floor(chunk/2));continue;}throw error;}
        if(logs.length>20000)throw new Error('Log budget exceeded');
        for(const log of logs){const iface=ds.escrow&&log.address.toLowerCase()===ds.escrow.toLowerCase()?escrowInterface:tokenInterface;let parsed;try{parsed=iface?.parseLog(log);}catch{continue;}if(!parsed)continue;
          let block=blockCache.get(log.blockNumber);if(!block){block=await provider.getBlock(log.blockNumber);blockCache.set(log.blockNumber,block);}if(!block?.hash)throw new Error('Missing block');
          const args=Object.fromEntries(parsed.fragment.inputs.map((input,i)=>[input.name,String(parsed.args[i])]));
          batch.push({id:stableId('event',[ds.id,log.transactionHash,log.index]),datasetId:ds.id,chainId:ds.chainId,address:log.address,name:parsed.name,args,txHash:log.transactionHash,blockNumber:log.blockNumber,blockHash:log.blockHash,timestamp:block.timestamp,transactionIndex:log.transactionIndex,logIndex:log.index,finality:finalizedBlock!==undefined&&log.blockNumber<=finalizedBlock?'finalized':head-log.blockNumber>=3?'confirmed':'provisional'});
        }
        start=stop+1;
      }
      const last=await provider.getBlock(end);if(!last?.hash)throw new Error('Missing cutoff block');
      const complete={blockNumber:end,blockHash:last.hash,timestamp:last.timestamp,head,finalizedBlock,coverageComplete:true,syncedAt:new Date().toISOString(),status:'ok',fromBlock:ds.fromBlock??ds.deploymentBlock,
        coverageMethod:cursor?.coverageMethod??'rpc-log-scan',replay:ds.adapter==='erc20'&&ds.toBlock!==undefined,
        ...(ds.collection?{capturedAt:ds.collection.capturedAt,sourceLimitations:ds.collection.limitations}:{}),
        ...(ds.adapter==='erc20'&&cursor?.coverageMethod?{refreshMethod:'复用已采集覆盖记录；本次核对截止区块与新增区块，不代表重新全量获取旧窗口'}:{})};
      this.store.transaction(()=>{for(const e of batch){this.store.addEvent(e);this.store.put('evidence',this.eventEvidence(ds,e));this.store.block(ds.id,e.blockNumber,e.blockHash);}for(const e of this.store.events(ds.id)){const finality=finalizedBlock!==undefined&&e.blockNumber<=finalizedBlock?'finalized':head-e.blockNumber>=3?'confirmed':'provisional';if(e.finality!==finality){const updated={...e,finality} as ChainEvent;this.store.updateEvent(updated);this.store.put('evidence',this.eventEvidence(ds,updated));}}this.store.block(ds.id,end,last.hash!);this.store.checkpointPut(ds.id,complete);});
      if(ds.adapter==='gym'){const snapshot=await this.snapshot(ds,end);for(const alert of gymAlerts(ds,this.store.events(ds.id),last.timestamp,snapshot))this.store.put('alerts',alert);}
      return complete;
    } catch {
      const failed={...this.store.checkpoint(ds.id),status:'error',coverageComplete:false,error:'链上同步失败；当前数据可能不完整。',attemptedAt:new Date().toISOString()};this.store.checkpointPut(ds.id,failed);return failed;
    } finally {this.busy.delete(ds.id);provider.destroy();}
  }
  eventEvidence(ds:Dataset,event:ChainEvent):Evidence{return {id:event.id,datasetId:ds.id,chainId:ds.chainId,kind:'event',asOfBlock:event.blockNumber,capturedAt:new Date().toISOString(),txHash:event.txHash,explorerUrl:explorer(ds,event.txHash),facts:{event,dataOrigin:ds.dataOrigin,...(ds.collection?{collection:ds.collection}:{})},coverage:{complete:true,missing:[]}};}
  async relatedTransfers(ds:Dataset,address:string,cutoff:number){
    if(![1,11155111].includes(ds.chainId))throw new Error('Public-chain follow-up only');
    const checkpoint=this.store.checkpoint(ds.id),scope=followupScope(ds,this.store.events(ds.id),address,cutoff),{fromBlock,toBlock}=scope;
    if(toBlock-fromBlock>10000||fromBlock>toBlock||toBlock>cutoff)throw new Error('Follow-up window outside bounded scope');
    const rpc=new ReadRpc(ds.chainId===1?config.mainnetRpc:config.sepoliaRpc,30,AbortSignal.timeout(14000),ds.chainId===1?config.mainnetFallbackRpc:undefined);
    const evidenceId=stableId('followup',[ds.id,address.toLowerCase(),fromBlock,toBlock,'post-receipt-120-v1']);
    const saved=this.store.get<Evidence>('evidence',evidenceId);
    // Fixed finalized historical cases can replay already completed pagination.
    // The tool still rechecks receipts online and openly preserves index capture time.
    const cachedIndex=ds.chainId===1&&ds.toBlock!==undefined&&saved?.coverage.complete&&Array.isArray(saved.facts.rawIndexPages)&&saved.facts.rawIndexPages.length?saved.facts.rawIndexPages as any[]:null;
    const chainCheck=rpc.call('eth_chainId',[]);
    const iface=new Interface(tokenAbi);let logs:any[],indexSource:unknown=null,rawIndexPages:unknown[]=[],rawReceipts:unknown[]=[];
    if(ds.chainId===1){
      const indexQuery=cachedIndex?Promise.resolve({items:cachedIndex.flatMap(p=>p.response.items).filter((i:any)=>i.block_number>=fromBlock&&i.block_number<=toBlock),pages:cachedIndex,limitation:'回放此前完整分页索引；本次返回转出重新核对 RPC 收据，索引本身并非本次重新采集。'}):indexedTransfers(address,ds.token,fromBlock,toBlock,4,AbortSignal.timeout(12000));
      const [actualChain,indexed]=await Promise.all([chainCheck,indexQuery]);
      if(Number(BigInt(actualChain))!==ds.chainId)throw new Error('Network mismatch');
      const outgoing=indexed.items.filter(i=>i.from.hash.toLowerCase()===address.toLowerCase()&&(!scope.anchor||i.block_number>scope.anchor.blockNumber||i.log_index>scope.anchor.logIndex));
      // Never silently replace an unverified full index with a claimed full RPC scan.
      if(outgoing.length>20)throw new Error('Follow-up receipt budget exceeded; narrower window required');
      const receipts=new Map<string,any>();const hashes=Array.from(new Set(outgoing.map(i=>i.transaction_hash)));
      for(let offset=0;offset<hashes.length;offset+=4)await Promise.all(hashes.slice(offset,offset+4).map(async h=>{receipts.set(h,await rpc.call('eth_getTransactionReceipt',[h]));}));
      logs=outgoing.map(i=>{const r=receipts.get(i.transaction_hash),l=r?.logs?.find((l:any)=>Number(BigInt(l.logIndex))===i.log_index&&l.address.toLowerCase()===ds.token.toLowerCase());if(!l||r.status!=='0x1'||l.blockHash!==i.block_hash)throw new Error('Follow-up index/receipt mismatch');const p=iface.parseLog(l)!;if(String(p.args.value)!==i.total.value||String(p.args.from).toLowerCase()!==i.from.hash.toLowerCase()||String(p.args.to).toLowerCase()!==i.to.hash.toLowerCase())throw new Error('Follow-up transfer mismatch');return l;});
      indexSource={host:'eth.blockscout.com',pages:indexed.pages.length,mode:cachedIndex?'saved-finalized-window-with-online-receipt-recheck':'live-index-query',capturedAt:indexed.pages.at(-1)?.receivedAt,limitation:indexed.limitation};
      rawIndexPages=indexed.pages;rawReceipts=[...receipts.values()];
    }else{if(Number(BigInt(await chainCheck))!==ds.chainId)throw new Error('Network mismatch');logs=await rpc.logs(ds.token,fromBlock,toBlock,[TRANSFER_TOPIC,addressTopic(address)],1000);}
    // Receipt log fields anchor these transfers to actual blocks; individual timestamps are
    // not invented when not queried. A separate get_tx_evidence call verifies receipts.
    const transfers=logs.map(l=>{const parsed=iface.parseLog(l)!;return {txHash:l.transactionHash,blockNumber:Number(BigInt(l.blockNumber)),blockHash:l.blockHash,logIndex:Number(BigInt(l.logIndex)),from:String(parsed.args.from),to:String(parsed.args.to),value:String(parsed.args.value)};});
    const total=transfers.reduce((sum,t)=>sum+BigInt(t.value),0n).toString();
    const data={address,token:ds.token,...scope,ruleVersion:'post-receipt-120-v1',totalRaw:total,count:transfers.length,positiveCount:transfers.filter(t=>BigInt(t.value)>0n).length,transfers:transfers.slice(-40),truncated:transfers.length>40,requestCount:rpc.requests,indexSource,limitation:'仅观察目标向该地址最大一笔正数转入之后至随后最多120个区块（或案例截止块）的本 token 转出，同块排除锚点前的日志。不是全日后续流向，不是逐枚归属；更晚的流动未查询。未查询的逐笔时间戳不显示。主网索引已完整分页且返回转出逐笔核对收据，但无法独立证明索引绝无遗漏。'};
    const evidence:Evidence={id:evidenceId,datasetId:ds.id,chainId:ds.chainId,kind:'window',asOfBlock:toBlock,capturedAt:new Date().toISOString(),facts:{followup:data,rawLogs:logs,rawIndexPages,rawReceipts,query:{address:ds.token,topics:[TRANSFER_TOPIC,addressTopic(address)],fromBlock,toBlock},rpcHost:new URL(rpc.url).hostname,rpcTrace:rpc.trace},coverage:{complete:!!checkpoint?.coverageComplete,missing:checkpoint?.coverageComplete?[]:['主案例覆盖不完整']}};
    this.store.put('evidence',evidence);return {data,evidenceIds:[evidenceId]};
  }
  async snapshot(ds:Dataset,blockNumber:number){
    if(ds.adapter!=='gym'||!ds.escrow)throw new Error('Gym-only tool unavailable for this dataset');const p=providerFor(ds);
    try{const c=new Contract(ds.escrow,readJSON('shared/artifacts/GymEscrow.json').abi,p),t=new Contract(ds.token,tokenAbi,p);
      const [a,merchant,payout,tokenAssets,sessionPrice,cardDuration,requestDuration]=await Promise.all([c.getAccounting({blockTag:blockNumber}),c.merchant({blockTag:blockNumber}),c.payoutAddress({blockTag:blockNumber}),t.balanceOf(ds.escrow,{blockTag:blockNumber}),c.sessionPrice({blockTag:blockNumber}),c.cardDuration({blockTag:blockNumber}),c.requestDuration({blockTag:blockNumber})]);
      if(a.assets!==tokenAssets)throw new Error('Snapshot inconsistency');
      const state={blockNumber,assets:String(a.assets),userCredit:String(a.userCredit),revenue:String(a.revenue),surplus:String(a.surplus),deficit:String(a.deficit),merchant,payout,sessionPrice:String(sessionPrice),cardDuration:String(cardDuration),requestDuration:String(requestDuration),rules:'消费请求由商家申请，会员本人确认才扣减未消费额度并增加商家可提现额度；申请者不是会员。商家只能提取已确认消费形成的额度；未消费额度可由会员本人退款。',mechanism:{implementation:'本项目不可升级 GymEscrow，权限机制基于已交付源码和本地合约测试，快照由同一区块 RPC 读取。',requestConsumptionCaller:merchant,setPayoutAddressCaller:merchant,withdrawCaller:merchant,withdrawLimit:'merchantAvailable，仅已确认消费',confirmConsumptionCaller:'请求记录的 user',refundCaller:'余额拥有者本人',withdrawalFrequencyLimit:'本版本未设置',withdrawalPercentageLimit:'本版本未设置；仅检查金额不超过可提额度',payoutCooldown:'本版本未设置；改址后提现触发分析提醒，不是合约禁止行为'}};
      const evidenceId=stableId('state',[ds.id,blockNumber]);this.store.put('evidence',{id:evidenceId,datasetId:ds.id,chainId:ds.chainId,kind:'state',asOfBlock:blockNumber,capturedAt:new Date().toISOString(),facts:state,coverage:{complete:true,missing:[]}});return {...state,evidenceId};
    }finally{p.destroy();}
  }
  async user(ds:Dataset,address:string){if(!ds.escrow)throw new Error('Not a gym dataset');const p=providerFor(ds);try{const c=new Contract(ds.escrow,readJSON('shared/artifacts/GymEscrow.json').abi,p),t=new Contract(ds.token,tokenAbi,p);const blockNumber=await p.getBlockNumber();const [balance,wallet,until,active]=await Promise.all([c.balances(address,{blockTag:blockNumber}),t.balanceOf(address,{blockTag:blockNumber}),c.validUntil(address,{blockTag:blockNumber}),c.activeRequest(address,{blockTag:blockNumber})]);const request=active?await c.requests(active,{blockTag:blockNumber}):null;return {address,blockNumber,balance:String(balance),wallet:String(wallet),remainingVisits:String(balance/30n),validUntil:Number(until),activeRequest:request?{id:String(active),amount:String(request.amount),expiresAt:Number(request.expiresAt),status:Number(request.status)}:null};}finally{p.destroy();}}
  async tx(ds:Dataset,hash:string){
    if(ds.chainId===1){const rpc=new ReadRpc(config.mainnetRpc,20,AbortSignal.timeout(14000),config.mainnetFallbackRpc);if(Number(BigInt(await rpc.call('eth_chainId',[])))!==1)throw new Error('Network mismatch');const [tx,receipt]=await Promise.all([rpc.call('eth_getTransactionByHash',[hash]),rpc.call('eth_getTransactionReceipt',[hash])]);
      if(tx.hash.toLowerCase()!==hash.toLowerCase()||receipt.transactionHash.toLowerCase()!==hash.toLowerCase()||tx.blockHash!==receipt.blockHash)throw new Error('Transaction/receipt disagreement');
      if(!receipt.logs.some((l:any)=>l.address.toLowerCase()===ds.token.toLowerCase())&&tx.to?.toLowerCase()!==ds.token.toLowerCase())throw new Error('Transaction outside dataset scope');
      const evidence:Evidence={id:stableId('tx',[ds.id,hash]),datasetId:ds.id,chainId:1,kind:'transaction',asOfBlock:Number(BigInt(receipt.blockNumber)),capturedAt:new Date().toISOString(),txHash:hash,explorerUrl:explorer(ds,hash),facts:{hash,from:tx.from,to:tx.to,status:Number(BigInt(receipt.status)),blockNumber:Number(BigInt(receipt.blockNumber)),blockHash:receipt.blockHash,logs:receipt.logs.map((l:any)=>({address:l.address,topics:l.topics,data:l.data,index:Number(BigInt(l.logIndex))})),gasUsed:BigInt(receipt.gasUsed).toString(),rawTransaction:tx,rawReceipt:receipt,rpcHosts:[...new Set(rpc.trace.filter(t=>t.ok).map(t=>t.host))]},coverage:{complete:true,missing:[]}};this.store.put('evidence',evidence);return evidence;
    }
    const p=providerFor(ds);try{const [tx,receipt]=await Promise.all([p.getTransaction(hash),p.getTransactionReceipt(hash)]);if(!tx||!receipt)throw new Error('Transaction not found');const known=ds.adapter==='gym'?[ds.token,ds.escrow]:[ds.token];if(!receipt.logs.some(l=>known.some(a=>a?.toLowerCase()===l.address.toLowerCase()))&&!known.some(a=>a?.toLowerCase()===tx.to?.toLowerCase()))throw new Error('Transaction outside dataset scope');const id=stableId('tx',[ds.id,hash]);const facts={hash,from:tx.from,to:tx.to,status:receipt.status,blockNumber:receipt.blockNumber,blockHash:receipt.blockHash,logs:receipt.logs.map(l=>({address:l.address,topics:l.topics,data:l.data,index:l.index})),gasUsed:String(receipt.gasUsed)};const evidence:Evidence={id,datasetId:ds.id,chainId:ds.chainId,kind:'transaction',asOfBlock:receipt.blockNumber,capturedAt:new Date().toISOString(),txHash:hash,explorerUrl:explorer(ds,hash),facts,coverage:{complete:true,missing:[]}};this.store.put('evidence',evidence);return evidence;}finally{p.destroy();}
  }
}
