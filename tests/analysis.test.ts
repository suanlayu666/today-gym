import {describe,it} from 'node:test';
import assert from 'node:assert/strict';
import {validateDraft} from '../server/agent.ts';
import {basisPoints,gymAlerts,transferMetrics} from '../server/rules.ts';
import {verifiedFacts} from '../server/report-facts.ts';
import type {Dataset,Evidence,ChainEvent} from '../shared/types.ts';

// These are synthetic unit fixtures, not evidence of public-chain execution.
const ds:Dataset={id:'fixture',chainId:31337,dataOrigin:'synthetic',adapter:'gym',name:'test',token:'0x'+'1'.repeat(40),tokenSymbol:'GYM',decimals:0,deploymentBlock:1};
const tx='0x'+'a'.repeat(64);
const ev:Evidence={id:'e1',datasetId:ds.id,chainId:ds.chainId,kind:'event',asOfBlock:10,capturedAt:'2026-10-06T00:00:00Z',txHash:tx,facts:{amount:'30'},coverage:{complete:true,missing:[]}};
const draft=()=>({headline:'已结算额度提现',findings:[{text:'提现记录可核查',type:'fact',evidenceIds:['e1']}],hypotheses:[{explanation:'可能是正常经营结算，需要线下核实',supportingEvidenceIds:['e1'],contradictingEvidenceIds:[],unresolved:['无法确认经营意图']}],consumerImpact:'须核验资产和负债',recommendations:['核查营业状态'],limitations:['链上记录不能证明线下服务质量']});
const event=(name:string,args:Record<string,string>,overrides:Partial<ChainEvent>={}):ChainEvent=>({id:'event',datasetId:ds.id,chainId:ds.chainId,address:ds.token,name,args,txHash:tx,blockNumber:10,blockHash:'0x'+'b'.repeat(64),timestamp:100000,transactionIndex:0,logIndex:0,finality:'confirmed',...overrides});

describe('Report evidence boundaries (synthetic unit fixtures)',()=>{
  it('accepts a scoped evidence-backed draft',()=>assert.equal(validateDraft(draft(),ds,[ev],10).findings.length,1));
  it('rejects a fact without evidence',()=>{const d=draft();d.findings[0].evidenceIds=[];assert.throws(()=>validateDraft(d,ds,[ev]));});
  it('rejects cross-dataset and cross-network hypothesis references',()=>{
    for(const bad of [{...ev,datasetId:'other'},{...ev,chainId:1}]){const d=draft();d.findings[0].type='unknown';d.findings[0].evidenceIds=[];assert.throws(()=>validateDraft(d,ds,[bad]));}
  });
  it('rejects evidence after the investigation cutoff',()=>assert.throws(()=>validateDraft(draft(),ds,[ev],9)));
  it('rejects fabricated hashes outside findings too',()=>{const d=draft();d.headline='调查 '+('0x'+'c'.repeat(64));assert.throws(()=>validateDraft(d,ds,[ev]));});
  it('rejects a real hash cited against the wrong evidence',()=>{const d=draft();d.findings[0].text='交易 '+tx;assert.throws(()=>validateDraft(d,ds,[{...ev,txHash:undefined}]));});
  it('rejects definitive accusations in a headline',()=>{const d=draft();d.headline='已经跑路';assert.throws(()=>validateDraft(d,ds,[ev]));});
  it('accepts explicit uncertainty instead of mistaking negated accusations for convictions',()=>{const d=draft();d.headline='不能证实已经跑路';validateDraft(d,ds,[ev]);d.headline='无法判断跑路概率';validateDraft(d,ds,[ev]);d.headline='不能断言全部资金已转出，不等于全部资金被再转出';validateDraft(d,{...ds,adapter:'erc20'},[ev]);d.headline='未取得余额，但已经证实跑路';assert.throws(()=>validateDraft(d,ds,[ev]));});
  it('does not equate no alert with normality or withdrawal with another member debit',()=>{const d=draft();d.headline='属正常调拨波动而非异常';assert.throws(()=>validateDraft(d,ds,[ev]));d.headline='未触发规则，不证明真实活动正常';d.consumerImpact='随后的提现使会员未消费额度减少';assert.throws(()=>validateDraft(d,ds,[ev]));d.consumerImpact='提现不会扣减会员余额；会员确认才减少未消费额度';validateDraft(d,ds,[ev]);});
  it('rejects unrelated mainnet consumer-protection claims',()=>{const d=draft();d.consumerImpact='会员未消费额度安全';assert.throws(()=>validateDraft(d,{...ds,adapter:'erc20'},[ev]));});
  it('does not apply ERC20 daily-baseline fields to a gym investigation',()=>{
    const d=draft();for(const text of ['current.topRecipient 未能确认','合计最大接收方未知','gym-v1 的 flags 未触发','触发 MAIN_GROWTH']){d.headline=text;assert.throws(()=>validateDraft(d,ds,[ev]));}
    d.headline='gym-v1 未返回提醒，不能证明经营正常';validateDraft(d,ds,[ev]);
  });
  it('does not describe unused-credit refunds as reversals of consumed services',()=>{
    const d=draft();d.headline='随后该笔消费被退款平账';assert.throws(()=>validateDraft(d,ds,[ev]));
    d.headline='退款撤销已确认消费';assert.throws(()=>validateDraft(d,ds,[ev]));
    d.headline='退款只返还未消费额度，不代表该笔消费被退款平账';validateDraft(d,ds,[ev]);
    d.headline='不给出跑路概率或定性结论';validateDraft(d,ds,[ev]);
    d.headline='不要以退款金额与消费金额相同推断该笔消费被退款';validateDraft(d,ds,[ev]);
  });
  it('rejects injected additional output fields',()=>assert.throws(()=>validateDraft({...draft(),execute:'withdraw'},ds,[ev])));
  it('rejects a false monetary amount despite a valid evidence ID',()=>{const d=draft();d.findings[0].text='提现 3000 GYM';assert.throws(()=>validateDraft(d,ds,[ev]));});
  it('rejects invented raw amounts and incomplete guessed digits',()=>{const d=draft();d.findings[0].text='转出 999999 raw';assert.throws(()=>validateDraft(d,ds,[ev]));d.findings[0].text='转出 30 raw';validateDraft(d,ds,[ev]);d.findings[0].text='可能回入 291925450021？级';d.findings[0].type='inference';assert.throws(()=>validateDraft(d,ds,[ev]));});
  it('rejects alerts absent from the deterministic flags and unqueried whole-balance claims',()=>{
    const main={...ds,adapter:'erc20' as const},metric={...ev,facts:{metrics:{rule:{version:'usdc-flow-v1',growthBps:'50000'},flags:[],current:{total:'250'},baseline:{days:7,total:'700'},relativeTotalBps:'25000',relativeCountBps:'10000'}}};const d=draft();d.findings[0].text='因此属规模提醒';assert.throws(()=>validateDraft(d,main,[metric]));d.findings[0].text='未触发规模提醒';validateDraft(d,main,[metric]);d.headline='接收地址的资金整体再转出';assert.throws(()=>validateDraft(d,main,[metric]));
    d.headline='不能表述为全部资金、全部余额或整体再转出';validateDraft(d,main,[metric]);
    d.headline='比日均高2.5倍，金额高于均值不等于触发规模提醒';validateDraft(d,main,[metric]);d.headline='比日均高0.25倍';assert.throws(()=>validateDraft(d,main,[metric]));d.headline='日均水平高于评估日单日总量';assert.throws(()=>validateDraft(d,main,[metric]));
    d.headline='地址 0x1111111111111111111111111111111111111111 的对照报告';validateDraft(d,main,[metric]);d.headline='总量除以此前7日合计再除以7';assert.throws(()=>validateDraft(d,main,[metric]));
    d.headline='未触发时不得暗示触发规模或集中度提醒';validateDraft(d,main,[metric]);d.headline='无规模或集中度提醒';validateDraft(d,main,[metric]);d.headline='该地址触发规模或集中度提醒';assert.throws(()=>validateDraft(d,main,[metric]));
  });
  it('checks headline amount precision, not just factual findings',()=>{const usd={...ds,adapter:'erc20' as const,tokenSymbol:'USDC',decimals:6},money={...ev,facts:{total:'1256160344465382'}};const d=draft();d.headline='转出约1,256,160 USDC';assert.throws(()=>validateDraft(d,usd,[money]));d.headline='转出1256160344.465382 USDC';validateDraft(d,usd,[money]);});
  it('does not rename a different follow-up recipient as the aggregate-largest recipient',()=>{const main={...ds,adapter:'erc20' as const},metric={...ev,id:'metric',facts:{metrics:{rule:{version:'usdc-flow-v1'},current:{total:'30',topRecipient:'top'},baseline:{days:7,total:'70'},flags:[]}}},follow={...ev,id:'follow',facts:{followup:{address:'other'}}};const d=draft();d.findings[0]={text:'对合计最大接收方的补查没有返回正数转出',type:'inference',evidenceIds:['follow']};assert.throws(()=>validateDraft(d,main,[metric,follow,ev]));d.findings[0].text='对实际查询的接收地址的补查没有返回正数转出';validateDraft(d,main,[metric,follow,ev]);});
  it('does not mistake a date or ERC20 label for a token amount',()=>{const usd={...ds,adapter:'erc20' as const,tokenSymbol:'USDC',decimals:6};const d=draft();d.headline='2026-09-30 USDC 调查';validateDraft(d,usd,[ev]);d.headline='主网 ERC20 USDC 链上记录';validateDraft(d,usd,[ev]);d.headline='2026-09-30 转出 99 USDC';assert.throws(()=>validateDraft(d,usd,[ev]));d.headline='转出99 USDC';assert.throws(()=>validateDraft(d,usd,[ev]));});
  it('rejects a mislabeled state amount',()=>{const d=draft();d.findings[0].text='assets=30';assert.throws(()=>validateDraft(d,ds,[ev]));});
  it('accepts the exact amount and converts configured token precision',()=>{const d=draft();d.findings[0].text='提现 30 GYM';validateDraft(d,ds,[ev]);const usd={...ds,adapter:'erc20' as const,tokenSymbol:'USDC',decimals:6};d.findings[0].text='转出 30 USDC';validateDraft(d,usd,[{...ev,facts:{value:'30000000'}}]);});
});

describe('Quantitative rules (synthetic unit fixtures)',()=>{
  it('calculates large integer basis points without floating point',()=>{assert.equal(basisPoints(900719925474099300n,1000799917193443667n),'8999');assert.equal(basisPoints(1n,0n),null);});
  it('does not call an ordinary 30-token withdrawal anomalous',()=>assert.deepEqual(gymAlerts(ds,[event('Withdrawn',{amount:'30',availableBefore:'30'})],100000,null),[]));
  it('flags a concentrated withdrawal with its exact denominator',()=>{const alerts=gymAlerts(ds,[event('Withdrawn',{amount:'300',availableBefore:'300'})],100000,null);assert.equal(alerts[0].ruleId,'R1');assert.equal(alerts[0].metrics.basisPoints,'10000');});
  it('does not mistake an earlier block with a higher log index for a later payout',()=>{
    const change=event('PayoutAddressChanged',{newAddress:'new'},{id:'change',blockNumber:11,logIndex:0});
    const before=event('Withdrawn',{amount:'30',availableBefore:'30'},{id:'before',blockNumber:10,logIndex:20});
    const alerts=gymAlerts(ds,[before,change],100000,null);assert.equal(alerts.some(a=>a.ruleId==='R2'),false);assert.equal(alerts[0].ruleId,'ADDRESS_INFO');
  });
  it('detects a same-block payout change followed by withdrawal',()=>{
    const change=event('PayoutAddressChanged',{newAddress:'new'},{id:'change',logIndex:1});
    const after=event('Withdrawn',{amount:'30',availableBefore:'30'},{id:'after',logIndex:2});
    assert.equal(gymAlerts(ds,[change,after],100000,null)[0].ruleId,'R2');
  });
  it('calculates transfer metrics with a left-closed, right-open window',()=>{
    const target='0x'+'2'.repeat(40),recipient='0x'+'3'.repeat(40);
    const events=[event('Transfer',{from:target,to:recipient,value:'10'},{id:'a',timestamp:100}),event('Transfer',{from:target,to:recipient,value:'20'},{id:'b',timestamp:200})];
    const m=transferMetrics(events,target,100,200);assert.equal(m.count,1);assert.equal(m.total,'10');assert.deepEqual(m.eventIds,['a']);
  });
});

describe('Program-generated facts (synthetic unit fixtures)',()=>{
  it('uses scoped successful tools only and does not rename the recipient as the call target',()=>{
    const t={...ev,id:'tx-fact',kind:'transaction' as const,facts:{blockNumber:10,status:1,from:'0x'+'2'.repeat(40),to:ds.token}};
    const run={id:'tool',name:'get_tx_evidence',arguments:{txHash:tx},startedAt:'unit',status:'ok' as const,evidenceIds:[t.id],summary:'unit'};
    const facts=verifiedFacts(ds,[t,{...t,id:'ignored',datasetId:'other'}],[run],10);assert.equal(facts.length,1);assert.deepEqual(facts[0].evidenceIds,[t.id]);assert.match(facts[0].text,/代币接收方需查看收据日志/);
    assert.throws(()=>verifiedFacts(ds,[t],[{...run,status:'error'}],10));assert.throws(()=>verifiedFacts(ds,[t],[run],9));
  });
  it('projects precision, flags and zero-valued follow-up logs without inventing balances',()=>{
    const usd={...ds,adapter:'erc20' as const,tokenSymbol:'USDC',decimals:6};
    const m={...ev,id:'metric',facts:{metrics:{current:{total:'13200000000000',count:3,maxSingle:'11200000000000',singleConcentrationBps:'8484',topRecipient:'recipient'},baseline:{days:7,total:'62000400000150'},rule:{version:'usdc-flow-v1'},flags:['MAIN_CONCENTRATION']},display:{relativeTotalRatio:'1.4903',currentVersusDailyMean:'高于此前7日日均'}}};
    const f={...ev,id:'follow',facts:{followup:{address:'recipient',fromBlock:5,toBlock:10,totalRaw:'0',count:1,positiveCount:0}}};
    const run={id:'tool',name:'compute_metrics',arguments:{},startedAt:'unit',status:'ok' as const,evidenceIds:[m.id],summary:'unit'};
    const facts=verifiedFacts(usd,[m,f],[run,{...run,id:'follow',name:'get_token_transfers',evidenceIds:[f.id]}],10);
    assert.equal(facts.length,3);assert.match(facts[0].text,/13200000\.0 USDC/);assert.match(facts[1].text,/MAIN_CONCENTRATION/);assert.match(facts[2].text,/0 条正数、1 条零金额/);validateDraft({...draft(),findings:facts,hypotheses:[{...draft().hypotheses[0],supportingEvidenceIds:[m.id]}]},usd,[m,f],10);
  });
});
