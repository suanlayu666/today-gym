import assert from 'node:assert/strict';
import {JsonRpcProvider} from 'ethers';
import {config,writeJSON} from '../server/config.ts';
import {Store} from '../server/store.ts';
import type {Dataset,Report,Evidence,ChainEvent} from '../shared/types.ts';

// Actual local API/EVM acceptance. Reads existing UI transactions; sends none.
const base=`http://127.0.0.1:${config.port}/api`;
async function get(path:string){const response=await fetch(base+path);assert.ok(response.ok);return (await response.json()).data;}
const results:any[]=[],store=new Store(),provider=new JsonRpcProvider(config.localRpc,31337,{staticNetwork:true,cacheTimeout:-1});
try{
  const cfg=await get('/config'),ds=cfg.datasets.find((d:Dataset)=>d.name==='本地健身房'&&d.adapter==='gym');assert.ok(ds);
  const overview=await get('/overview?datasetId='+ds.id),user=await get('/users/'+ds.users[0]+'?datasetId='+ds.id);
  assert.equal(user.balance,'2880');assert.equal(user.remainingVisits,'96');assert.equal(overview.snapshot.assets,'2880');assert.equal(overview.snapshot.revenue,'0');assert.equal(overview.businessSummary.todayRevenue,'60');assert.equal(overview.businessSummary.pending.length,0);
  results.push({name:'actual new member and merchant summary after two UI-confirmed consumptions and withdrawals',passed:true,memberCredit:user.balance,visits:user.remainingVisits,merchantRevenue:overview.snapshot.revenue,todayRevenue:overview.businessSummary.todayRevenue});
  const events=store.events(ds.id).filter(e=>e.blockNumber>=87&&['ConsumptionRequested','ConsumptionConfirmed','Withdrawn'].includes(e.name));assert.equal(events.length,6);
  for(const event of events){const receipt=await provider.getTransactionReceipt(event.txHash);assert.equal(receipt?.status,1);assert.equal(receipt?.blockHash,event.blockHash);}
  results.push({name:'six real UI business transaction receipts, no snapshots or rollback',passed:true,events:events.map(e=>({name:e.name,blockNumber:e.blockNumber,txHash:e.txHash}))});
  const job=overview.latestJob;assert.ok(job?.automaticKey);assert.equal(job.status,'complete');
  const report=await get('/reports/'+job.reportId) as Report;assert.equal(report.mode,'llm');assert.equal(report.status,'complete');assert.equal(report.asOfBlock,91);assert.equal(report.toolRuns.filter(t=>t.status==='ok').length,6);
  for(const ref of [...new Set(report.findings.flatMap(f=>f.evidenceIds))]){const e=await get('/evidence/'+ref) as Evidence;assert.equal(e.datasetId,ds.id);assert.equal(e.chainId,31337);assert.ok(e.asOfBlock<=report.asOfBlock);}
  results.push({name:'actual background-triggered DeepSeek investigation and scoped evidence',passed:true,jobId:job.id,reportId:report.id,tools:report.toolRuns.map(t=>({name:t.name,status:t.status})),automaticKey:job.automaticKey});
  const currentJobs=store.list('jobs',ds.id).filter(j=>j.automaticKey===job.automaticKey);assert.equal(currentJobs.length,1);assert.equal(overview.backgroundMonitoring,true);
  results.push({name:'automatic monitoring enabled after human authorization, one job for current alert key',passed:true,count:currentJobs.length});
  writeJSON('artifacts/acceptance/simplified-experience.json',{at:new Date().toISOString(),passed:true,results,scope:'Real local UI/EVM and real DeepSeek. Existing public mainnet cases preserved; no Sepolia deployment, no second Agent, no new full-contract rollback suite. This verifier sends no transaction or model request.'});
  console.log(JSON.stringify({passed:true,checks:results.length,reportId:report.id}));
}finally{provider.destroy();store.close();}
