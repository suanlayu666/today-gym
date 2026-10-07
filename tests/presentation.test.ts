import {it} from 'node:test';
import assert from 'node:assert/strict';
import {preferredGym,isManagementRoute,memberEvents,pendingRequests,fundingStatus,usefulAlerts,usableReport,confirmedToday,investigationNotice} from '../web/src/presentation.ts';
import type {Dataset,ChainEvent,Alert,Report} from '../shared/types.ts';
// Presentation-only fixtures; these are not on-chain or real LLM proofs.
const event=(name:string,args:Record<string,string>,timestamp=1)=>({name,args,timestamp} as ChainEvent);
it('ordinary entry selects a gym, not mainnet or anomaly; technical routes stay in management',()=>{
  const mainnet={id:'main',adapter:'erc20'} as Dataset,anomaly={id:'bad',adapter:'gym',name:'本地异动',dataOrigin:'local-chain'} as Dataset,normal={id:'gym',adapter:'gym',name:'本地健身房',dataOrigin:'local-chain'} as Dataset;
  assert.equal(preferredGym([mainnet,anomaly,normal])?.id,'gym');assert.equal(preferredGym([mainnet]),undefined);
  assert.equal(isManagementRoute('/consumer'),false);assert.equal(isManagementRoute('/merchant'),false);
  for(const route of ['/admin','/investigations','/cases','/reports/x'])assert.equal(isManagementRoute(route),true);
});
it('member activity is own business records only; pending is not confused with completed/rejected',()=>{
  const events=[event('Deposited',{user:'0xAbC',amount:'3000'}),event('Transfer',{from:'0xabc',value:'3000'}),event('Deposited',{user:'0xdef',amount:'3000'}),event('ConsumptionRequested',{user:'0xabc',id:'1'}),event('ConsumptionConfirmed',{user:'0xabc',id:'1'}),event('ConsumptionRequested',{user:'0xdef',id:'2'})];
  assert.equal(memberEvents(events,'0xabc').length,3);assert.equal(memberEvents(events,'').length,0);assert.deepEqual(pendingRequests(events).map(e=>e.args.id),['2']);
});
it('funding says unknown on failures/missing/invalid balances, and never equates covered with risk-free',()=>{
  assert.equal(fundingStatus({assets:'900719925474099399',userCredit:'900719925474099300',revenue:'99'},true).tone,'good');
  assert.equal(fundingStatus({assets:'1',userCredit:'2',revenue:'0'},true).tone,'attention');
  for(const [s,ready] of [[undefined,true],[{assets:'0',userCredit:'0'},true],[{assets:'10',userCredit:'2',revenue:'1'},false]])assert.equal(fundingStatus(s,Boolean(ready)).tone,'neutral');
  assert.match(fundingStatus({assets:'3',userCredit:'2',revenue:'1'},true).text,/不保证/);
});
it('personal notices do not attribute another member concentration to self',()=>{
  const alerts=[{ruleId:'R4',metrics:{user:'0xdef'}},{ruleId:'R1',metrics:{}}] as Alert[];
  assert.equal(usefulAlerts(alerts,'0xabc').length,1);assert.equal(usefulAlerts(alerts,'0xdef').length,2);assert.equal(usefulAlerts(alerts,'',true).length,2);
});
it('AI summary never treats partial/stale/future/cross-case reports as completed results',()=>{
  const report={id:'ok',datasetId:'gym',mode:'llm',status:'complete',asOfBlock:5,generatedAt:'2026-10-07'} as Report;
  const reports=[{...report,id:'partial',status:'partial'},{...report,id:'stale',status:'stale'},{...report,id:'future',asOfBlock:99},{...report,id:'other',datasetId:'main'},report] as Report[];
  assert.equal(usableReport(reports,'gym',6)?.id,'ok');assert.equal(usableReport(reports,'gym'),undefined);
});
it('today income uses only confirmations on actual current day, not withdrawals or historical demo totals',()=>{
  const now=new Date('2026-10-07T12:00:00+08:00').getTime();
  assert.equal(confirmedToday([event('ConsumptionConfirmed',{amount:'30'},now/1000-100),event('Withdrawn',{amount:'600'},now/1000-200),event('ConsumptionConfirmed',{amount:'720'},now/1000-86400)],now),'30');
  assert.equal(confirmedToday([event('ConsumptionConfirmed',{amount:'30'},now/1000+300),event('ConsumptionConfirmed',{amount:'60'},now/1000+86400)],now),'30');
});
it('failed/partial AI remains explicit even when an older complete report exists',()=>{
  const report={} as Report;
  assert.match(investigationNotice(true,false,{status:'partial'},report,true),/未完成/);
  assert.match(investigationNotice(false,false,{status:'complete'},report,true),/无法更新/);
  assert.match(investigationNotice(true,true,undefined,report,true),/正在/);
  assert.match(investigationNotice(true,false,{status:'complete'},report,true),/已有/);
});
