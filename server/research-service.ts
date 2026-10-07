import {randomUUID} from 'node:crypto';
import type express from 'express';
import {Interface,formatUnits} from 'ethers';
import {z} from 'zod';
import {Store} from './store.ts';
import {ChainService,tokenAbi} from './chain.ts';
import {Investigator,validateDraft} from './agent.ts';
import {runFlowStage,callFlowModel,type FlowModel} from './flow-agent.ts';
import {config,readJSON,writeJSON} from './config.ts';
import {mainnetMetrics} from './mainnet-metrics.ts';
import {ReadRpc} from './rpc.ts';
import {comparisonCases} from './comparison-cases.ts';
import {percentBps} from '../shared/flow-view.ts';
import type {Dataset,Report,Evidence} from '../shared/types.ts';
import type {FlowEvent,FlowStage,FlowToolRun} from '../shared/flow.ts';
import type {ResearchCase,ResearchRun,ResearchOverview,ResearchMetrics} from '../shared/research.ts';
import {exactTokenAmount} from '../shared/research.ts';
import type {PlainReport} from '../shared/plain-report.ts';

export function validateResearchInterpretation(ds:Dataset,r:NonNullable<FlowStage['result']>,runs:FlowToolRun[],allEvidence:Evidence[],cutoff:number){
  const successful=runs.filter(t=>t.status==='ok'),ids=new Set(successful.flatMap(t=>t.evidenceIds));
  const evidence=allEvidence.filter(e=>ids.has(e.id));
  // The summary cites the metric, receipt and follow-up evidence, not every
  // historical event. This preserves semantic checks without exceeding the
  // older report schema's twenty-citation limit per finding.
  const summaryIds=[...new Set(successful.filter(t=>t.name!=='list_events').flatMap(t=>t.evidenceIds))].slice(0,20);
  const texts=[r.summary,r.recommendation,...r.observations.map(o=>o.text),...r.alternatives,...r.limitations];
  if(ds.collection?.complete&&ds.analysisWindow&&ds.analysisWindow.to-ds.analysisWindow.from===86400)for(const text of texts){
    for(const match of text.matchAll(/(?:评估日|该日|当日)(?:的)?(?:样本|窗口|数据|记录)?(?:窗口)?.{0,8}(?:不完整|未覆盖完整|没有覆盖完整|未覆盖全日)|(?:需|应)(?:要)?补齐完整一日/g)){
      if(!/(?:不能|不应|不可|并非|不是|不代表|未证明)[^。；]{0,25}$/.test(text.slice(Math.max(0,match.index!-35),match.index)))throw new Error('Unsupported window coverage claim: assessment is a full UTC day with saved complete pagination; index omission uncertainty is not a known truncated day.');
    }
  }
  return validateDraft({headline:'公开主网资金异动核查',findings:[...r.observations,{type:'unknown',text:r.summary,evidenceIds:summaryIds}],hypotheses:r.alternatives.map(explanation=>({explanation,supportingEvidenceIds:[...ids],contradictingEvidenceIds:[],unresolved:r.limitations})),consumerImpact:'这是公开主网研究案例，与健身房会员权益无关。',recommendations:[r.recommendation],limitations:r.limitations},ds,evidence,cutoff);
}

export function researchSummary(metrics:ResearchMetrics,run?:ResearchRun):PlainReport{
  const amount=exactTokenAmount(metrics.current.total,metrics.decimals),ratio=metrics.relativeTotalBps===null?'无法计算':formatUnits(metrics.relativeTotalBps,4)+' 倍';
  const base:PlainReport={tone:'unknown',label:'历史案例 · 等待本次核查',title:metrics.flags.length?'这个地址的资金转出有值得核实的变化':'这个对照窗口没有触发规则提醒',happened:`评估日，这个公开地址转出 ${amount} USDC。${metrics.relativeTotalBps===null?'此前基线不足，暂时无法比较转出规模。':`与此前七日日均相比，为 ${ratio}。`}`,reasons:[],nextStep:'运行只读调查，对照正常解释和需要关注的线索。',boundary:'这是公开主网地址的历史研究案例，不是健身房账单。不能据此判断现实身份、经营用途或商家是否会关门。',checkedAt:run?.finishedAt??null};
  base.reasons=metrics.flags.map(f=>f==='MAIN_CONCENTRATION'?`最大一笔占当日转出的 ${percentBps(metrics.current.singleConcentrationBps)}，需要核实集中付款的用途。`:'当天转出明显高于此前七日日均，需要核实变化原因。');
  if(!base.reasons.length)base.reasons.push('按当前演示规则，这个窗口没有触发规模增长或单笔集中提醒；不代表活动已被证明正常。');
  base.reasons.push('集中结算或资金归集也是可能解释，需要结合接收方活动核查，不能只看阈值。');
  if(!run)return base;
  if(run.status==='partial')return {...base,label:'本次检查未完成',title:'证据或智能体检查未完成，暂时不能给出完整判断',nextStep:'查看下方缺口，恢复连接后重新核查。'};
  if(run.status!=='complete')return {...base,label:'正在核查',nextStep:'正在查询公开链证据并独立复核，结果会自动更新。'};
  const follow=run.stages.find(s=>s.name==='reviewer')?.toolRuns.find(t=>t.name==='trace_recipient'&&t.status==='ok')?.result as {positiveCount?:number}|undefined;
  if(typeof follow?.positiveCount==='number')base.reasons.push(follow.positiveCount>0?'对这笔最大转出的接收账户补查时，观察到了后续转出。这是继续调查的线索，不能说明转出的就是原来那笔钱。':'对这笔最大转出的接收账户补查时，窄窗口内未发现正金额后续转出。不能据此认定没有其他资金活动。');
  const risk=run.risk;
  return {...base,tone:risk==='attention'?'attention':risk==='no-signal'?'neutral':'unknown',label:risk==='attention'?'建议核实用途':risk==='no-signal'?'暂未发现明确风险线索':risk==='disputed'?'两位智能体存在分歧':'现有证据不足',title:risk==='attention'?'资金行为值得关注，但原因仍需核实':risk==='no-signal'?'本次调查没有得出明确的风险判断':risk==='disputed'?'存在不同解释，需要补充证据':'能确认资金变化，暂时无法确认真实原因',nextStep:'结合下方支持线索、正常解释与证据缺口决定是否继续调查；不据此认定跑路。'};
}

export class ResearchService{
  busy?:string;current=new Map<string,ResearchRun>();investigator:Investigator;
  constructor(readonly store:Store,readonly chain:ChainService,readonly model:FlowModel=callFlowModel){this.investigator=new Investigator(store,chain);}
  datasets(){return this.store.list<Dataset>('datasets').filter(d=>d.chainId===1&&d.dataOrigin==='public-mainnet'&&d.adapter==='erc20'&&['anomaly','control'].includes(d.caseRole??'')&&d.analysisWindow&&d.collection?.complete);}
  dataset(id:string){const ds=this.datasets().find(d=>d.id===id);if(!ds)throw new Error('案例不在允许范围');return ds;}
  file(ds:Dataset){return 'data/research/'+ds.caseRole+'-latest.json';}
  runFor(ds:Dataset){const current=this.current.get(ds.id);if(current)return current;try{const saved=readJSON<ResearchRun>(this.file(ds));if(saved.datasetId!==ds.id||saved.asOfBlock!==ds.toBlock)return undefined;if(['investigating','reviewing'].includes(saved.status))return {...saved,status:'partial' as const,error:'上次核查被服务重启中断，不能当作已完成。'};
    if(saved.status==='complete')try{for(const s of saved.stages){if(s.status!=='complete'||!s.result)throw Error('Incomplete stage');validateResearchInterpretation(ds,s.result,s.toolRuns,this.store.list<Evidence>('evidence',ds.id),saved.asOfBlock);}}catch{return {...saved,status:'partial' as const,error:'此前解释未通过当前证据与范围校验，不能当作完整结果；请重新核查。'};}
    return saved;}catch{return undefined;}}
  getCase(ds:Dataset):ResearchCase{
    const events=this.store.events(ds.id).filter(e=>e.blockNumber<=ds.toBlock!),metrics=mainnetMetrics(ds,events),outgoing=events.filter(e=>metrics.current.eventIds.includes(e.id)&&BigInt(e.args.value)>0n).sort((a,b)=>BigInt(a.args.value)>BigInt(b.args.value)?-1:BigInt(a.args.value)<BigInt(b.args.value)?1:0);
    if(!outgoing.length)throw new Error('评估日没有可核验转出');
    const anchor=outgoing[0],run=this.runFor(ds),previous=this.store.list<Report>('reports',ds.id).find(r=>r.status==='complete'&&r.mode==='llm');
    return {id:ds.id,role:ds.caseRole!,name:ds.caseRole==='anomaly'?'集中转出案例':'未触发规则的对照案例',dataset:ds,metrics,summary:researchSummary(metrics,run),run,anchor:{txHash:anchor.txHash,from:anchor.args.from,to:anchor.args.to,amount:anchor.args.value,blockNumber:anchor.blockNumber},...(previous?{previousInvestigation:{generatedAt:previous.generatedAt,toolCalls:previous.toolRuns.length,headline:previous.headline}}:{})};
  }
  overview():ResearchOverview{const cases:ResearchCase[]=[];let error:string|undefined;for(const ds of this.datasets())try{cases.push(this.getCase(ds));}catch{error='部分历史案例缺少可重算数据，未作为完整案例展示。';}return {cases,comparisons:comparisonCases(),modelConfigured:!!config.llmKey&&config.llmEnabled,...(error?{error}:{})};}
  save(ds:Dataset,run:ResearchRun){this.current.set(ds.id,structuredClone(run));writeJSON(this.file(ds),run);if(run.finishedAt)writeJSON('data/research/history/'+run.id+'.json',run);}
  start(id:string){const ds=this.dataset(id);if(this.busy===id)return this.current.get(id)!;if(this.busy)throw new Error('已有公共链核查运行，请稍后再试。');if(!config.llmKey||!config.llmEnabled)throw new Error('尚未配置模型');
    const run:ResearchRun={id:randomUUID(),datasetId:id,asOfBlock:ds.toBlock!,status:'investigating',stages:[],startedAt:new Date().toISOString(),online:{status:'pending',scope:'本次在线核对网络、截止区块和评估日最大转出收据；历史索引复用，非全窗口重新采集。'}};this.busy=id;this.save(ds,run);void this.execute(ds,run);return run;
  }
  async execute(ds:Dataset,run:ResearchRun){
    const rpc=new ReadRpc(config.mainnetRpc,30,AbortSignal.timeout(45000),config.mainnetFallbackRpc);
    try{
      const c=this.getCase(ds),events=this.store.events(ds.id),anchor=events.find(e=>e.txHash===c.anchor.txHash&&e.args.value===c.anchor.amount&&e.args.to===c.anchor.to)!;
      const cp=this.store.checkpoint(ds.id);if(!cp?.coverageComplete||cp.blockNumber!==ds.toBlock)throw new Error('历史窗口覆盖不足');
      if(Number(BigInt(await rpc.call('eth_chainId',[])))!==1)throw new Error('公共链网络不匹配');
      const [cutoff,receipt,block]=await Promise.all([rpc.block(ds.toBlock!),rpc.call('eth_getTransactionReceipt',[anchor.txHash]),rpc.block(anchor.blockNumber)]);
      const matching=receipt.logs?.find((l:any)=>Number(BigInt(l.logIndex))===anchor.logIndex&&l.address.toLowerCase()===ds.token.toLowerCase()),parsed=matching?new Interface(tokenAbi).parseLog(matching):null;
      if(cutoff.hash!==cp.blockHash||receipt.status!=='0x1'||receipt.transactionHash.toLowerCase()!==anchor.txHash.toLowerCase()||receipt.blockHash!==anchor.blockHash||block.hash!==anchor.blockHash||!parsed||parsed.args.value.toString()!==anchor.args.value||parsed.args.from.toLowerCase()!==anchor.args.from.toLowerCase()||parsed.args.to.toLowerCase()!==anchor.args.to.toLowerCase())throw new Error('公开链与已保存案例不一致');
      run.online={...run.online,status:'verified',checkedAt:new Date().toISOString(),chainId:1,cutoffHash:cutoff.hash,txHash:anchor.txHash,rpcHosts:[...new Set(rpc.trace.filter(t=>t.ok).map(t=>t.host))]};this.save(ds,run);
      const event:FlowEvent={id:anchor.id,txHash:anchor.txHash,logIndex:anchor.logIndex,blockNumber:anchor.blockNumber,blockHash:anchor.blockHash,timestamp:anchor.timestamp,from:anchor.args.from,to:anchor.args.to,amount:anchor.args.value,kind:'withdrawal'};
      const execute=async(name:string,args:any)=>{
        if(name==='verify_transaction'&&args.txHash.toLowerCase()!==anchor.txHash.toLowerCase())throw new Error('本次仅核查锚点交易');
        if(name==='trace_recipient'&&args.address.toLowerCase()!==anchor.args.to.toLowerCase())throw new Error('本次仅核查锚点接收地址');
        const names:Record<string,string>={list_events:'get_business_events',compute_metrics:'compute_metrics',verify_transaction:'get_tx_evidence',trace_recipient:'get_token_transfers'};
        if(!names[name])throw new Error('只读工具范围之外');return this.investigator.executeTool(ds,names[name],args,ds.toBlock!);
      };
      const publish=(s:FlowStage)=>{const i=run.stages.findIndex(t=>t.name===s.name);if(i<0)run.stages.push(s);else run.stages[i]=s;this.save(ds,run);};
      const validate=(r:NonNullable<FlowStage['result']>,runs:FlowToolRun[])=>{
        validateResearchInterpretation(ds,r,runs,this.store.list<Evidence>('evidence',ds.id),ds.toBlock!);
      };
      const context={description:'此处是公开以太坊主网 USDC 历史地址资金研究，不是健身房、会员或预付卡数据。原始金额为6位小数代币的最小单位。指标是完整评估UTC日与此前七日基线对比，currentEvent只是选中的锚点交易，不是日窗口终点。历史索引已保存完整分页；第三方遗漏无法独立排除，不等于已知当日窗口不完整，也不等于按大额阈值过滤窗口记录。工具列表截断不改变完整事件的重算结果。使用 compute_metrics 的 flags 与 display，不要把单笔集中度写成总接收方集中度，后者是描述指标而非本次告警规则。',boundary:'历史索引复用保存的完整分页；交易收据重新在线查询。接收方仅锚点后最多120区块补查，不代表全日、跨协议或全部资产；不可断言全部余额、同一控制人、接收方身份、犯罪或资金逐枚归属。可提出资金归集等正常假设，但不能当成已证实事实。不在正文重写金额、倍数、地址或哈希，由工具和界面显示。',validate};
      const question='调查评估日资金变化：列出值得关注的线索，主动探索正常资金归集、结算或路径变化解释；用接收方补查检验哪些解释得到支持或仍未知。不要只重复告警，不把未触发规则当作正常证明。';
      const investigator=await runFlowStage('investigator',ds,event,question,execute,publish,undefined,this.model,context);
      if(investigator.status!=='complete')throw new Error('调查员未完成');run.status='reviewing';this.save(ds,run);
      const reviewer=await runFlowStage('reviewer',ds,event,question,execute,publish,investigator,this.model,context);
      if(reviewer.status!=='complete'||!reviewer.toolRuns.some(t=>t.name==='trace_recipient'&&t.status==='ok'))throw new Error('独立复核取证未完成');
      run.status='complete';run.risk=reviewer.result?.verdict==='disagree'?'disputed':reviewer.result?.verdict==='insufficient'?'insufficient':reviewer.result!.risk;
    }catch{run.status='partial';run.error=run.online.status==='verified'?'在线样本核验完成，但双 Agent 或报告校验未完整结束；请查看工具缺口。':'公共链连接、样本收据或历史窗口核验未完成；不能展示为公共链调查成功。';if(run.online.status!=='verified')run.online.status='failed';}
    finally{run.finishedAt=new Date().toISOString();this.save(ds,run);this.busy=undefined;}
    return run;
  }
}

export function mountResearch(app:express.Express,store:Store,chain:ChainService){
  const service=new ResearchService(store,chain);
  app.get('/api/research',(_req,res)=>{try{res.json({data:service.overview()});}catch{res.status(503).json({error:{message:'历史案例暂时不可用。'}});}});
  app.post('/api/research/investigations',(req,res)=>{try{const {datasetId}=z.object({datasetId:z.string().max(100)}).strict().parse(req.body);res.status(202).json({data:service.start(datasetId)});}catch{res.status(400).json({error:{message:'无法启动核查：检查模型配置、案例范围，或等待当前任务完成。'}});}});
  app.get('/api/research/cases/:id/export',(req,res)=>{try{const ds=service.dataset(String(req.params.id)),c=service.getCase(ds);const ids=new Set(c.run?.stages.flatMap(s=>s.toolRuns.filter(t=>t.status==='ok').flatMap(t=>t.evidenceIds))||[]);const evidence=store.list<Evidence>('evidence',ds.id).filter(e=>ids.has(e.id)&&e.chainId===1&&e.asOfBlock<=ds.toBlock!);res.setHeader('Content-Disposition',`attachment; filename="today-gym-public-${ds.caseRole}.json"`);res.json({data:{case:c,evidence,boundary:'公开历史研究，不是健身房流水；模拟样例不包含在本证据报告中。'}});}catch{res.status(400).json({error:{message:'案例或证据报告不可用。'}});}});
  return service;
}
