import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Contract,JsonRpcProvider} from 'ethers';
import {config,readJSON,writeJSON} from '../server/config.ts';
import {Store} from '../server/store.ts';
import type {FlowOverview} from '../shared/flow.ts';
const base='http://127.0.0.1:'+config.port+'/api/flow';
async function request(path:string,body?:unknown){const response=await fetch(base+path,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(90000)});const json=await response.json();return {status:response.status,data:json.data};}
const overview=async()=>(await request('')).data as FlowOverview;
const checks:{name:string;result:string;detail?:unknown}[]=[];
const pass=(name:string,detail?:unknown)=>{checks.push({name,result:'pass',detail});console.log('通过：'+name);};
const before=await overview();assert.ok(before.ready&&before.signingEnabled);assert.equal(before.deployment!.chainId,31337);assert.ok(before.modelConfigured&&before.automaticAnalysis);pass('本地链、模型和自动核查均真实启用');
const d=before.deployment!;
const resume=process.argv.includes('--resume');
const invalid=await request('/transfers',{role:'userA',amount:'0',to:d.accounts.merchant,requestId:randomUUID()});assert.equal(invalid.status,400);pass('零金额拒绝');
const wrong=await request('/transfers',{role:'userA',amount:'1',to:d.accounts.payout,requestId:randomUUID()});assert.equal(wrong.status,400);pass('会员不能通过付款接口转给其他地址');
const large=await request('/transfers',{role:'userA',amount:'9999999999999999',to:d.accounts.merchant,requestId:randomUUID()});assert.equal(large.status,400);pass('余额不足拒绝');
let input={role:'userB',amount:'863',to:d.accounts.merchant,requestId:randomUUID()};
if(resume){const history=new Store('data/direct-flow.sqlite');try{const previous=history.list<any>('evidence',d.id).find(e=>e.confirmed&&e.input?.role==='userB'&&e.input?.amount==='863');assert.ok(previous,'没有可续验的已确认付款');input=previous.input;}finally{history.close();}}
const first=await request('/transfers',input);assert.equal(first.status,200);assert.equal(first.data.confirmed,true);const second=await request('/transfers',input);assert.equal(second.data.txHash,first.data.txHash);assert.equal(second.data.reused,true);const paid=await overview();assert.equal(BigInt(before.balances!.userB)-BigInt(paid.balances!.userB),resume?0n:863n);assert.equal(paid.events.filter(e=>e.txHash===first.data.txHash).length,1);pass('自由金额付款、收款只计一次、同请求重试不重复转账',{txHash:first.data.txHash,resumedExistingReceipt:resume});
const n=BigInt(paid.balances!.merchant)*9n/10n;
const previousWithdrawal=paid.events.find(e=>e.kind==='withdrawal');
const withdrawal=resume?{status:200,data:{txHash:previousWithdrawal?.txHash,confirmed:!!previousWithdrawal}}:await request('/transfers',{role:'merchant',amount:n.toString(),to:d.accounts.payout,requestId:randomUUID()});assert.equal(withdrawal.status,200);assert.equal(withdrawal.data.confirmed,true);pass('商家自由转出链上记录，不经过托管',{txHash:withdrawal.data.txHash,resumedExistingReceipt:resume});
let downstreamHash='';
if(resume){downstreamHash=paid.events.find(e=>e.kind==='recipient-transfer')?.txHash||'';assert.ok(downstreamHash);}else{const p=new JsonRpcProvider(config.localRpc,31337,{staticNetwork:true,cacheTimeout:-1});try{const signer=await p.getSigner(d.accounts.payout),token=new Contract(d.token,readJSON('shared/artifacts/GymToken.json').abi,signer);const tx=await token.transfer(d.accounts.nextPayout,1n);assert.equal((await tx.wait())!.status,1);downstreamHash=tx.hash;}finally{p.destroy();}}
const external=await overview();assert.ok(external.events.find(e=>e.txHash===downstreamHash&&e.kind==='recipient-transfer'));pass('网站外发起的一层关联转账也被监控',{txHash:downstreamHash});
const merchantEvent=external.events.find(e=>e.txHash===withdrawal.data.txHash)!;
const rerun=await request('/investigations',{eventId:merchantEvent.id,question:'重新核查最新已入块的商家转出与直接接收地址，明确证据和正常解释。'});assert.equal(rerun.status,200);
console.log('等待真实 DeepSeek 调查与复核；不是测试替身。');
const deadline=Date.now()+10*60*1000;let final=external;
while(Date.now()<deadline){final=await overview();const pending=final.jobs.filter(j=>['queued','investigating','reviewing'].includes(j.status));if(!pending.length)break;await new Promise(resolve=>setTimeout(resolve,3000));}
const newEvents=resume?final.events:final.events.filter(e=>!before.events.some(b=>b.id===e.id));
for(const event of newEvents){const job=final.jobs.find(j=>j.eventId===event.id&&j.status==='complete');assert.ok(job,'事件没有完成真实双 Agent 核查：'+event.kind);const report=final.reports.find(r=>r.id===job.reportId)!;assert.equal(report.status,'complete');assert.equal(report.stages.length,2);for(const stage of report.stages){for(const name of ['list_events','compute_metrics','verify_transaction'])assert.ok(stage.toolRuns.some(t=>t.name===name&&t.status==='ok'));}pass('真实双 Agent 完成 '+event.kind+' 调查',{eventId:event.id,reportId:report.id,risk:report.risk,toolRuns:report.stages.map(s=>({agent:s.name,count:s.toolRuns.length}))});}
const withdrawalReport=final.reports.find(r=>r.eventId===merchantEvent.id&&r.status==='complete')!;assert.ok(withdrawalReport.metrics.flags.some(f=>f.includes('80%')));assert.ok(withdrawalReport.stages[0].toolRuns.some(t=>t.name==='trace_recipient'&&t.status==='ok'));pass('高转出比例信号、资金去向工具及证据报告可用');
const foreign=await fetch(base,{headers:{Origin:'https://invalid.example'},signal:AbortSignal.timeout(10000)});assert.equal(foreign.status,403);pass('拒绝第三方网页来源');
writeJSON('artifacts/acceptance/direct-flow-results.json',{at:new Date().toISOString(),scope:'本地 EVM 实际交易与真实 DeepSeek 两阶段工具调用；不代表 Sepolia 或生产安全审计',chainId:31337,checks,events:final.events,reports:final.reports});
console.log('验收通过 '+checks.length+' 项，证据已保存。');
