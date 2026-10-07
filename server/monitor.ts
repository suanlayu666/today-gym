import type {Alert,ChainEvent,Dataset,Report} from '../shared/types.ts';
import {stableId} from './rules.ts';

export function automaticInvestigation(ds:Dataset,checkpoint:any,events:ChainEvent[],alerts:Alert[],reports:Report[],jobs:any[],enabled:boolean,now=Date.now()){
  if(!enabled||ds.adapter!=='gym'||checkpoint?.status!=='ok'||!checkpoint.coverageComplete)return;
  const relevant=alerts.filter(a=>a.severity!=='info'&&a.window.from<=checkpoint.timestamp&&a.window.to>checkpoint.timestamp);
  if(!relevant.length||jobs.some(j=>['queued','running'].includes(j.status)))return;
  const lastEvent=events.reduce((n,e)=>Math.max(n,e.blockNumber),0),cutoff=relevant.some(a=>a.ruleId==='R6')?checkpoint.blockNumber:lastEvent;
  if(reports.some(r=>r.status==='complete'&&r.mode==='llm'&&r.datasetId===ds.id&&r.asOfBlock>=cutoff&&r.asOfBlock<=checkpoint.blockNumber))return;
  const automaticKey=stableId('automatic',[ds.id,relevant.map(a=>[a.ruleId,...a.evidenceIds].sort()).sort()]);
  if(jobs.some(j=>j.automaticKey===automaticKey))return;
  // Persisted dedupe, plus a five-minute cooldown; no repeated paid calls on polling/restarts.
  if(jobs.some(j=>j.automaticKey&&now-Date.parse(j.createdAt)<300000))return;
  return {automaticKey,question:'自动核查最新消费确认、提现和收款地址变化。说明未消费额度是否有资产覆盖，区分事实与推断，保留正常解释和反证，给出会员与商家可执行的建议。不认定跑路，不给出概率。'};
}
