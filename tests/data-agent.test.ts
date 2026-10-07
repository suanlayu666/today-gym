import {describe,it} from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../server/store.ts';
import {Investigator} from '../server/agent.ts';
import {config} from '../server/config.ts';
import {mainnetMetrics} from '../server/mainnet-metrics.ts';
import {followupScope} from '../server/followup.ts';
import type {Dataset,Evidence,ChainEvent,Report} from '../shared/types.ts';

const ds:Dataset={id:'unit-ds',chainId:31337,dataOrigin:'synthetic',adapter:'gym',name:'unit',token:'0x'+'1'.repeat(40),tokenSymbol:'GYM',decimals:0,deploymentBlock:1};
const txHash='0x'+'a'.repeat(64);
const event:ChainEvent={id:'event-unit',datasetId:ds.id,chainId:ds.chainId,address:ds.token,name:'ConsumptionConfirmed',args:{user:'0x'+'2'.repeat(40),amount:'30'},txHash,blockNumber:10,blockHash:'0x'+'b'.repeat(64),timestamp:100000,transactionIndex:0,logIndex:0,finality:'confirmed'};
const evidence:Evidence={id:event.id,datasetId:ds.id,chainId:ds.chainId,kind:'event',asOfBlock:10,txHash,capturedAt:'2026-10-06T00:00:00Z',facts:{event},coverage:{complete:true,missing:[]}};
const draft={headline:'记录已核验',findings:[{text:'确认可能对应服务，线下交付未知',type:'inference',evidenceIds:[event.id]}],hypotheses:[{explanation:'可能是正常消费确认，线下交付未知',supportingEvidenceIds:[event.id],contradictingEvidenceIds:[],unresolved:['实际到店未知']}],consumerImpact:'仅描述本地测试记录',recommendations:['核对实际服务'],limitations:['合成单元测试，不是公开链验收']};
function setup(){const s=new Store(':memory:');s.put('datasets',ds);s.addEvent(event);s.put('evidence',evidence);s.checkpointPut(ds.id,{blockNumber:10,timestamp:100000,coverageComplete:true});return s;}

describe('Index transactions and rollback (isolated synthetic fixtures)',()=>{
  it('deduplicates rescanned tx/log IDs',()=>{const s=setup();try{s.addEvent(event);assert.equal(s.events(ds.id).length,1);}finally{s.close();}});
  it('rolls back an interrupted database transaction atomically',()=>{const s=setup();try{assert.throws(()=>s.transaction(()=>{s.addEvent({...event,id:'future',blockNumber:11,logIndex:1});throw new Error('interrupt');}));assert.equal(s.events(ds.id).length,1);}finally{s.close();}});
  it('preserves ancestor evidence, removes orphan evidence and marks reports stale',()=>{const s=setup();try{s.addEvent({...event,id:'orphan',blockNumber:11,logIndex:1});s.put('evidence',{...evidence,id:'orphan',asOfBlock:11});s.put('reports',{...draft,id:'report',datasetId:ds.id,chainId:ds.chainId,dataOrigin:'synthetic',asOfBlock:11,mode:'llm',status:'complete',toolRuns:[],generatedAt:'2026-10-06T00:00:00Z'} as Report);s.rollback(ds.id,10);assert.equal(s.events(ds.id).length,1);assert.ok(s.get('evidence',evidence.id));assert.equal(s.get('evidence','orphan'),undefined);assert.equal(s.get('reports','report').status,'stale');assert.equal(s.checkpoint(ds.id).coverageComplete,false);}finally{s.close();}});
  it('keeps reports at/before a matched ancestor, but invalidates them on full reset',()=>{
    const s=setup();try{
      for(const block of [9,10,11])s.put('reports',{...draft,id:'report-'+block,datasetId:ds.id,chainId:ds.chainId,dataOrigin:'synthetic',asOfBlock:block,mode:'llm',status:'complete',toolRuns:[],generatedAt:'2026-10-06T00:00:00Z'} as Report);
      s.rollback(ds.id,10);
      assert.equal(s.get('reports','report-9').status,'complete');assert.equal(s.get('reports','report-10').status,'complete');assert.equal(s.get('reports','report-11').status,'stale');
      s.rollback(ds.id,0);
      for(const block of [9,10,11])assert.equal(s.get('reports','report-'+block).status,'stale');
      assert.equal(s.get('reports','report-11').limitations.filter((text:string)=>text.includes('链重组')).length,1);
    }finally{s.close();}
  });
});

describe('Mainnet quantifier (synthetic fixtures, not mainnet proof)',()=>{
  it('uses seven complete UTC days, rational baseline and identical thresholds',()=>{
    const target='0x'+'2'.repeat(40),start=8*86400,m:Dataset={...ds,chainId:1,adapter:'erc20',tokenSymbol:'USDC',decimals:6,target,analysisWindow:{from:start,to:start+86400},baselineDays:7};
    const events=Array.from({length:8},(_,i)=>({...event,id:'day'+i,name:'Transfer',timestamp:86400*(i+1),args:{from:target,to:'0x'+'3'.repeat(40),value:i===7?'700000000000':'100000000000'}}));
    const metrics=mainnetMetrics(m,events);assert.equal(metrics.baseline.days,7);assert.equal(metrics.baseline.total,'700000000000');assert.equal(metrics.relativeTotalBps,'70000');assert.deepEqual(metrics.flags,['MAIN_GROWTH','MAIN_CONCENTRATION']);
    const control=mainnetMetrics(m,events.map(e=>e.id==='day7'?{...e,args:{...e.args,value:'1000'}}:e));assert.equal(control.rule.version,metrics.rule.version);assert.deepEqual(control.flags,[]);
  });
  it('does not calculate a growth multiple on an empty baseline',()=>{const m:Dataset={...ds,adapter:'erc20',target:'0x'+'2'.repeat(40),analysisWindow:{from:86400*8,to:86400*9},baselineDays:7};assert.equal(mainnetMetrics(m,[]).relativeTotalBps,null);});
  it('rejects a short baseline or partial-day comparison',()=>{const m:Dataset={...ds,adapter:'erc20',target:'0x'+'2'.repeat(40),analysisWindow:{from:0,to:86400},baselineDays:6};assert.throws(()=>mainnetMetrics(m,[]));assert.throws(()=>mainnetMetrics({...m,baselineDays:7,analysisWindow:{from:0,to:100}},[]));});
});

describe('Fixed post-receipt follow-up scope (synthetic fixtures)',()=>{
  const target='0x'+'2'.repeat(40),recipient='0x'+'3'.repeat(40);
  const main:Dataset={...ds,chainId:1,adapter:'erc20',target,analysisWindow:{from:90000,to:110000},collection:{capturedAt:'unit',rpcHost:'unit',selection:'unit',complete:true,rawFile:'unit',followupFromBlock:5}};
  const transfer=(block:number,value:string,to=recipient):ChainEvent=>({...event,name:'Transfer',blockNumber:block,args:{from:target,to,value},id:'incoming-'+block});
  it('anchors the largest positive assessment-day transfer using integer amounts',()=>{const scope=followupScope(main,[transfer(20,'9007199254740993'),transfer(30,'9007199254740992'),transfer(40,'0')],recipient,500);assert.equal(scope.fromBlock,20);assert.equal(scope.toBlock,140);assert.equal(scope.anchor?.eventId,'incoming-20');assert.equal(scope.horizonBlocks,120);});
  it('caps the horizon at the case cutoff and rejects target/self or unrelated recipients',()=>{assert.equal(followupScope(main,[transfer(20,'30')],recipient,40).toBlock,40);assert.throws(()=>followupScope(main,[transfer(20,'30')],target,40));assert.throws(()=>followupScope(main,[transfer(20,'0')],recipient,40));assert.throws(()=>followupScope(main,[{...transfer(20,'30'),timestamp:110000}],recipient,40));});
});

describe('Agent execution boundaries (mock model; not real LLM proof)',{concurrency:false},()=>{
  it('rejects signing/shell tools and unknown arguments or addresses',async()=>{const s=setup();try{const agent=new Investigator(s,{} as any);for(const [name,args] of [['withdraw',{}],['shell',{command:'echo unsafe'}],['get_business_events',{url:'https://other.invalid'}],['get_token_transfers',{address:'0x'+'9'.repeat(40)}]] as const)await assert.rejects(()=>agent.executeTool(ds,name,args,10));}finally{s.close();}});
  it('bounds business-event output to 120 even when assessment fills every slot',async()=>{const s=new Store(':memory:');const main={...ds,adapter:'erc20' as const,analysisWindow:{from:100000,to:110000}};try{for(let i=0;i<130;i++)s.addEvent({...event,id:'limited-'+i,logIndex:i,timestamp:i<5?99999:100001});s.checkpointPut(ds.id,{coverageComplete:true});const result=await new Investigator(s,{} as any).executeTool(main,'get_business_events',{},10);assert.equal((result.data as any).events.length,120);assert.equal(result.evidenceIds.length,120);assert.equal((result.data as any).truncated,true);}finally{s.close();}});
  it('finishes at exactly ten tool calls instead of discarding the report',async()=>{
    const s=setup(),previous={enabled:config.llmEnabled,key:config.llmKey};config.llmEnabled=true;config.llmKey='unit-test-not-a-real-key';
    const stateId='state-unit';const chain:any={snapshot:async()=>{s.put('evidence',{...evidence,id:stateId,kind:'state',facts:{assets:'2970',userCredit:'2970',revenue:'0'}});return {assets:'2970',userCredit:'2970',revenue:'0',blockNumber:10,evidenceId:stateId};},tx:async()=>evidence};
    try{const agent=new Investigator(s,chain);let modelCalls=0;agent.callModel=async(body)=>{modelCalls++;if(body.response_format)return {content:JSON.stringify(draft)};return {content:null,tool_calls:['get_business_events','compute_metrics','get_escrow_snapshot','get_tx_evidence',...Array(6).fill('get_business_events')].map((name,i)=>({id:'call'+i,type:'function',function:{name,arguments:JSON.stringify(name==='get_tx_evidence'?{txHash}:{})}}))};};
      await agent.run({id:'budget-unit',datasetId:ds.id,question:'unit test',status:'queued',createdAt:'2026-10-06T00:00:00Z'},ds);const job=s.get('jobs','budget-unit');assert.equal(job.status,'complete');assert.equal(job.toolRuns.length,10);assert.equal(modelCalls,2);assert.equal(s.get('reports',job.reportId).mode,'llm');
    }finally{config.llmEnabled=previous.enabled;config.llmKey=previous.key;s.close();}
  });
  it('queues another dataset instead of failing it as busy',async()=>{
    const s=setup(),other={...ds,id:'queue-other'};s.put('datasets',other);const agent=new Investigator(s,{} as any);const completed:string[]=[];
    agent.run=async(job)=>{agent.running=true;await new Promise<void>(resolve=>setImmediate(resolve));completed.push(job.datasetId);s.put('jobs',{...job,status:'complete'});agent.running=false;queueMicrotask(()=>void agent.drain());};
    try{const first=agent.start(ds,'first'),second=agent.start(other,'second');assert.equal(s.get('jobs',second.id).status,'queued');for(let i=0;i<20&&completed.length<2;i++)await new Promise<void>(resolve=>setImmediate(resolve));assert.deepEqual(completed,[ds.id,other.id]);assert.equal(s.get('jobs',first.id).status,'complete');assert.equal(s.get('jobs',second.id).status,'complete');}finally{s.close();}
  });
});
