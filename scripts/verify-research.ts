import assert from 'node:assert/strict';
import {config,writeJSON} from '../server/config.ts';
import type {ResearchOverview,ResearchRun} from '../shared/research.ts';
import {validateResearchInterpretation} from '../server/research-service.ts';
const root='http://127.0.0.1:'+config.webPort,checks:{name:string;passed:boolean;detail?:unknown}[]=[],runs:ResearchRun[]=[];
const check=(name:string,fn:()=>unknown)=>{const detail=fn();checks.push({name,passed:true,...(detail===undefined?{}:{detail})});};
async function api(path='',body?:unknown){const r=await fetch(root+'/api/research'+path,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(15000)});const j=await r.json();assert.ok(r.ok,j.error?.message||'API failed');return j.data;}
try{
  const overview=await api() as ResearchOverview;
  check('两组公开主网历史案例与模拟样例严格分开',()=>{assert.equal(overview.cases.length,2);assert.equal(overview.comparisons.length,3);for(const c of overview.cases){assert.equal(c.dataset.chainId,1);assert.equal(c.dataset.dataOrigin,'public-mainnet');assert.equal(c.dataset.decimals,6);assert.ok(c.summary.boundary.includes('不是健身房'));}assert.ok(overview.comparisons.every(c=>c.origin==='synthetic'));});
  const bad=await fetch(root+'/api/research/investigations',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({datasetId:'direct-local-forbidden'})});check('拒绝跨入演示数据或未知案例',()=>assert.equal(bad.status,400));
  for(const c of overview.cases){
    let run=c.run;if(!run||run.status!=='complete'||process.argv.includes('--fresh'))run=await api('/investigations',{datasetId:c.id});
    const deadline=Date.now()+360000;let last='';
    while(['investigating','reviewing'].includes(run!.status)&&Date.now()<deadline){if(last!==run!.status){last=run!.status;console.log(c.name+'：'+last);}await new Promise(r=>setTimeout(r,2000));const latest=await api() as ResearchOverview;run=latest.cases.find(v=>v.id===c.id)!.run;}
    assert.ok(run);runs.push(run);console.log(c.name+'：'+run.status);
    check(c.name+'：在线公共链样本与截止区块核验',()=>{assert.equal(run.online.status,'verified');assert.equal(run.online.chainId,1);assert.equal(run.online.txHash,c.anchor.txHash);assert.ok(run.online.rpcHosts?.length);});
    check(c.name+'：真实双 Agent 各自取证',()=>{assert.equal(run.status,'complete',run.error);assert.equal(run.stages.length,2);for(const s of run.stages){assert.equal(s.status,'complete',s.error);for(const name of ['list_events','compute_metrics','verify_transaction','trace_recipient'])assert.ok(s.toolRuns.some(t=>t.name===name&&t.status==='ok'),name);const known=new Set(s.toolRuns.filter(t=>t.status==='ok').flatMap(t=>t.evidenceIds));assert.ok(s.result?.alternatives.length);for(const o of s.result!.observations){for(const id of o.evidenceIds)assert.ok(known.has(id));}}return run.stages.map(s=>({name:s.name,tools:s.toolRuns.length,risk:s.result!.risk}));});
    const exportResponse=await fetch(root+'/api/research/cases/'+encodeURIComponent(c.id)+'/export');const exported=await exportResponse.json();
    check(c.name+'：可导出来源、实际调用和原始引用证据',()=>{assert.equal(exportResponse.status,200);assert.ok(exportResponse.headers.get('Content-Disposition')?.includes('attachment'));assert.equal(exported.data.case.id,c.id);assert.equal(exported.data.case.run.id,run.id);const ids=new Set(exported.data.evidence.map((e:any)=>e.id));for(const s of run.stages){for(const t of s.toolRuns.filter(t=>t.status==='ok'))for(const id of t.evidenceIds)assert.ok(ids.has(id),'Missing exported evidence '+id);validateResearchInterpretation(c.dataset,s.result!,s.toolRuns,exported.data.evidence,run.asOfBlock);}for(const e of exported.data.evidence){assert.equal(e.chainId,1);assert.equal(e.datasetId,c.id);assert.ok(e.asOfBlock<=c.dataset.toBlock!);}return {evidenceCount:ids.size};});
  }
  const alien=await fetch(root+'/api/research',{headers:{Origin:'https://untrusted.example'}});check('拒绝外部网页来源',()=>assert.equal(alien.status,403));
  console.log(JSON.stringify({passed:true,checks:checks.length,cases:runs.map(r=>({datasetId:r.datasetId,status:r.status,risk:r.risk}))},null,2));
}catch(error){checks.push({name:'验收未完成',passed:false,detail:error instanceof Error?error.message:'Unknown'});process.exitCode=1;console.error(checks.at(-1));}
finally{writeJSON('artifacts/acceptance/public-research-results.json',{at:new Date().toISOString(),scope:'公开主网历史案例在线样本重核 + 双 Agent 实际工具调用；没有链上写入、资金交易或链重置',checks,runs,limitations:['历史索引复用，不是全窗口重新采集。','三种模拟方法样例不是 Agent 预测性能验证。','无法确认现实业务、地址身份或跑路。']});}
