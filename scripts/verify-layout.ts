import assert from 'node:assert/strict';
import {JsonRpcProvider} from 'ethers';
import {config,writeJSON} from '../server/config.ts';
import {Store} from '../server/store.ts';
import type {Dataset,Report,Evidence} from '../shared/types.ts';

// State-specific read-only acceptance of the actual UI refund and AI question.
// Does not submit transactions, invoke the model, restart or roll back the chain.
const store=new Store(),rpc=new JsonRpcProvider(config.localRpc,31337,{staticNetwork:true,cacheTimeout:-1}),checks:any[]=[];
async function get(endpoint:string){const response=await fetch(`http://127.0.0.1:${config.port}/api${endpoint}`,{signal:AbortSignal.timeout(20000)});assert.ok(response.ok);return (await response.json()).data;}
try{
  const cfg=await get('/config'),ds=cfg.datasets.find((d:Dataset)=>d.name==='本地健身房'&&d.adapter==='gym') as Dataset;assert.ok(ds);
  const query='?datasetId='+ds.id,overview=await get('/overview'+query),user=await get('/users/'+ds.users![0]+query);
  assert.equal(user.balance,'2820');assert.equal(user.wallet,'27060');assert.equal(user.remainingVisits,'94');assert.equal(overview.snapshot.assets,'2820');assert.equal(overview.snapshot.userCredit,'2820');assert.equal(overview.snapshot.revenue,'0');assert.equal(overview.businessSummary.todayRevenue,'90');assert.equal(overview.businessSummary.pending.length,0);
  checks.push({name:'actual balance after modal refund',passed:true,credit:user.balance,wallet:user.wallet,visits:user.remainingVisits,todayRevenue:overview.businessSummary.todayRevenue});
  const refund=store.events(ds.id).find(e=>e.blockNumber===96&&e.name==='Refunded'&&e.args.user.toLowerCase()===ds.users![0].toLowerCase());assert.ok(refund);assert.equal(refund.args.amount,'30');
  const receipt=await rpc.getTransactionReceipt(refund.txHash);assert.equal(receipt?.status,1);assert.equal(receipt?.blockHash,refund.blockHash);
  checks.push({name:'real local EVM receipt for refund submitted through new modal',passed:true,block:96,txHash:refund.txHash});
  const job=store.list('jobs',ds.id).find(j=>j.question?.includes('用户问题：我的未消费额度还在吗？')&&j.question.includes(ds.users![0])&&j.question.includes('当前身份：会员'));
  assert.ok(job);assert.equal(job.status,'complete');assert.ok(!job.automaticKey);
  const report=await get('/reports/'+job.reportId) as Report;assert.equal(report.datasetId,ds.id);assert.equal(report.chainId,31337);assert.equal(report.asOfBlock,96);assert.equal(report.mode,'llm');assert.equal(report.status,'complete');assert.ok(report.toolRuns.filter(t=>t.status==='ok').length>=2);
  checks.push({name:'real manually asked AI investigation binds current gym, member account and role',passed:true,jobId:job.id,reportId:report.id,asOfBlock:report.asOfBlock,tools:report.toolRuns.map(t=>({name:t.name,status:t.status}))});
  const refs=[...new Set([...report.findings.flatMap(f=>f.evidenceIds),...report.hypotheses.flatMap(h=>[...h.supportingEvidenceIds,...h.contradictingEvidenceIds])])];assert.ok(refs.length);
  for(const ref of refs){const evidence=await get('/evidence/'+ref) as Evidence;assert.equal(evidence.datasetId,ds.id);assert.equal(evidence.chainId,31337);assert.ok(evidence.asOfBlock<=report.asOfBlock);}
  checks.push({name:'actual report evidence API resolves within the same network and cutoff',passed:true,references:refs.length});
  assert.ok(cfg.datasets.filter((d:Dataset)=>d.adapter==='erc20'&&d.chainId===1).length>=2);assert.equal(overview.backgroundMonitoring,true);
  checks.push({name:'public mainnet study cases and authorized background gym investigation preserved',passed:true});
  writeJSON('artifacts/acceptance/layout-live-results.json',{at:new Date().toISOString(),passed:true,checks,scope:'Current local EVM demo state and real DeepSeek question, not Sepolia/public business deployment, independent multi-agent, all-natural-language semantic validation or a new full contract suite.'});
  console.log(JSON.stringify({passed:true,checks:checks.length,reportId:report.id}));
}finally{rpc.destroy();store.close();}
