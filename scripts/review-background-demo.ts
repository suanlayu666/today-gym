import assert from 'node:assert/strict';
import {Store} from '../server/store.ts';
import {writeJSON} from '../server/config.ts';
import type {Report,Evidence} from '../shared/types.ts';
// Development evidence review of the one newly generated demo, not model output.
const store=new Store();
try{
  const r=store.get<Report>('reports','a700580c-bdce-473e-b31f-5b4285832131');assert.ok(r);assert.equal(r.mode,'llm');assert.equal(r.status,'complete');assert.equal(r.asOfBlock,91);
  const state=store.get<Evidence>('evidence','state-2a23e54c4e2bc49cd8545c4a');assert.ok(state);assert.equal(state.asOfBlock,91);assert.equal(state.facts.revenue,'30');assert.equal(state.facts.assets,'2910');assert.equal(state.facts.userCredit,'2880');
  if(!r.review){writeJSON('data/report-reviews/background-demo-original.json',r);store.put('reports',{...r,review:{at:new Date().toISOString(),method:'development-evidence-review',excludedHypotheses:[],notes:[{text:'截至报告区块 91，商家仍有 30 GYM 可提现收入。原稿“可提现额度回到零、没有商家资金”不能作为报告截止状态；它至多描述此前已经提现的时点。报告之后区块 92 的提现不属于本报告的证据范围。',evidenceIds:[state.id]},{text:'会员地址签名确认不证明真人实际到店。符合本合约权限和额度限制不等于现实经营合法；链上覆盖也不是未来退款或履约保证。',evidenceIds:[state.id]}]}});}
  console.log(JSON.stringify({passed:true,reportId:r.id,originalModelRewritten:false,scope:'single report development review, not a second Agent'}));
}finally{store.close();}
