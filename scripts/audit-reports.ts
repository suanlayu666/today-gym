import {Store} from '../server/store.ts';
import {validateDraft} from '../server/agent.ts';
import {verifiedFacts,orderedFacts,FACT_VERSION} from '../server/report-facts.ts';
import {writeJSON} from '../server/config.ts';
import type {Dataset,Evidence,Report} from '../shared/types.ts';

const store=new Store(),at=new Date().toISOString(),changes:{reportId:string;reason:string;original:Report}[]=[],passed:string[]=[];
try{
  for(const report of store.list<Report>('reports').filter(r=>r.status==='complete'&&r.mode==='llm')){
    const ds=store.get<Dataset>('datasets',report.datasetId);if(!ds)continue;
    const evidence=store.list<Evidence>('evidence',ds.id).filter(e=>e.asOfBlock<=report.asOfBlock);
    try{const {headline,findings,hypotheses,consumerImpact,recommendations,limitations}=report;validateDraft({headline,findings,hypotheses,consumerImpact,recommendations,limitations},ds,evidence,report.asOfBlock);
      if(report.analysis?.factGeneration===FACT_VERSION&&JSON.stringify(orderedFacts(report.findings.filter(f=>f.type==='fact')))!==JSON.stringify(orderedFacts(verifiedFacts(ds,evidence,report.toolRuns,report.asOfBlock))))throw new Error('Program-generated facts no longer reproduce saved evidence');
      passed.push(report.id);
    }catch(error){changes.push({reportId:report.id,reason:error instanceof Error?error.message:'Report validation failed',original:report});}
  }
  // Preserve original reports before changing their validity label. No model prose is rewritten.
  const archive='data/report-audits/'+Date.now()+'.json';writeJSON(archive,{at,changes});
  store.transaction(()=>{for(const c of changes)store.put('reports',{...c.original,status:'partial',limitations:[...c.original.limitations,'历史报告未通过当前校验，不能作为已验收报告；原始版本已可恢复保存于 '+archive+'。']});});
  const result={at,passedReportIds:passed,reclassified:changes.map(c=>({reportId:c.reportId,reason:c.reason})),archive,scope:'当前程序校验；不证明全部自然语言语义，不重写模型输出，不替代公共业务验收'};
  writeJSON('artifacts/acceptance/report-audit.json',result);console.log(JSON.stringify({passed:passed.length,reclassified:changes.length,archive}));
}finally{store.close();}
