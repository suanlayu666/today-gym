import fs from 'node:fs';
import assert from 'node:assert/strict';
import {Store} from '../server/store.ts';
import {readJSON,writeJSON} from '../server/config.ts';
import {validateDraft,reportMarkdown} from '../server/agent.ts';
import {verifiedFacts,orderedFacts,FACT_VERSION} from '../server/report-facts.ts';
import type {Dataset,Evidence,Report} from '../shared/types.ts';

const store=new Store(),checks:{name:string;passed:boolean;details?:unknown}[]=[],results:any[]=[];
try{
  for(const [role,file] of [['mainnet-anomaly','cases/mainnet/anomaly.manifest.json'],['mainnet-control','cases/mainnet/control.manifest.json'],['local-normal','data/deployments/local.json'],['local-anomaly','data/deployments/local-anomaly.json']]){
    const ds=readJSON<Dataset>(file),report=store.list<Report>('reports',ds.id).find(r=>r.status==='complete'&&r.mode==='llm'&&r.analysis?.factGeneration===FACT_VERSION);assert.ok(report,role+': 当前事实版本的实际模型报告尚未完成');
    assert.equal(report.chainId,ds.chainId);assert.equal(report.dataOrigin,ds.dataOrigin);assert.ok(!['synthetic'].includes(ds.dataOrigin));
    const evidence=store.list<Evidence>('evidence',ds.id).filter(e=>e.asOfBlock<=report.asOfBlock),{headline,findings,hypotheses,consumerImpact,recommendations,limitations}=report;
    validateDraft({headline,findings,hypotheses,consumerImpact,recommendations,limitations},ds,evidence,report.asOfBlock);assert.deepEqual(orderedFacts(findings.filter(f=>f.type==='fact')),orderedFacts(verifiedFacts(ds,evidence,report.toolRuns,report.asOfBlock)));
    checks.push({name:role+': schema, citations, numerical assertions and deterministic facts',passed:true});
    for(const required of ['get_business_events','compute_metrics','get_tx_evidence',ds.adapter==='gym'?'get_escrow_snapshot':'get_token_transfers'])assert.ok(report.toolRuns.some(t=>t.status==='ok'&&t.name===required));
    const job=store.list('jobs',ds.id).find(j=>j.reportId===report.id&&j.status==='complete');assert.ok(job,role+': 缺实际完成任务');
    const revised='data/drafts/'+job.id+'.revised.json',original='data/drafts/'+job.id+'.json',draft=JSON.parse(readJSON(fs.existsSync(revised)?revised:original).content);
    assert.deepEqual({...draft,findings:draft.findings},{headline,findings:findings.filter(f=>f.type!=='fact'),hypotheses,consumerImpact,recommendations,limitations});
    checks.push({name:role+': report interpretation matches persisted actual model response',passed:true});
    if(ds.adapter==='gym'){const state=evidence.find(e=>report.toolRuns.some(t=>t.evidenceIds.includes(e.id))&&e.kind==='state')!;assert.ok(state);assert.ok(BigInt(String(state.facts.assets))>=BigInt(String(state.facts.userCredit))+BigInt(String(state.facts.revenue)));
      checks.push({name:role+': saved same-block accounting coverage',passed:true});}
    writeJSON('artifacts/acceptance/'+role+'-report.json',report);writeJSON('artifacts/acceptance/'+role+'-markdown.json',{reportId:report.id,markdown:reportMarkdown(report)});
    results.push({role,datasetId:ds.id,reportId:report.id,jobId:job.id,asOfBlock:report.asOfBlock,chainId:ds.chainId,toolCalls:report.toolRuns.length,factCount:findings.filter(f=>f.type==='fact').length});
  }
  console.log(JSON.stringify({passed:true,checks:checks.length,results},null,2));
}catch(error){checks.push({name:'verification halted',passed:false,details:error instanceof Error?error.message:'Unknown'});console.error(JSON.stringify(checks.at(-1)));process.exitCode=1;}
finally{writeJSON('artifacts/acceptance/report-verification.json',{at:new Date().toISOString(),checks,results,limitations:['此脚本验证程序引用、原始模型稿一致性和保存状态，不证明所有自然语言解释。','公开主网在线再核查另见 verify:mainnet:online。','本地业务不替代 Sepolia 公共业务验收。']});store.close();}
