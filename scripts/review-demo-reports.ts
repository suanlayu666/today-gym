import assert from 'node:assert/strict';
import {Store} from '../server/store.ts';
import {readJSON,writeJSON} from '../server/config.ts';
import type {Report,Evidence} from '../shared/types.ts';

// Developer evidence review of the four already accepted demo reports.
// This is not LLM output or a second Agent. Preserve every original model field.
const store=new Store(),at=new Date().toISOString(),originals:Report[]=[],results:unknown[]=[];
const frozenIds:Record<string,string>={
  'local-normal':'66b4b531-0728-43b5-8bd2-b165b2eeb977',
  'local-anomaly':'99c893f2-4d6c-4803-a760-262dfa4283fb',
  'mainnet-anomaly':'724ce936-b009-4601-bd72-59cb3b982d85',
  'mainnet-control':'4a0d9e83-e652-44d7-8655-ee17b311f875'
};
try{
  const updates:Report[]=[];
  for(const [role,id] of Object.entries(frozenIds)){
    const report=store.get<Report>('reports',id)!;assert.ok(report&&report.status==='complete'&&report.mode==='llm',role+': expected actual complete AI report');
    const evidence=store.list<Evidence>('evidence',report.datasetId),metric=report.analysis?.metricsEvidenceId;
    const state=report.toolRuns.find(t=>t.status==='ok'&&t.name==='get_escrow_snapshot')?.evidenceIds[0];
    const notes:NonNullable<Report['review']>['notes']=[];let excludedHypotheses:number[]=[];
    const add=(text:string,ids:(string|undefined)[])=>notes.push({text,evidenceIds:ids.filter((id):id is string=>!!id)});
    if(role==='local-normal'){
      const events=store.events(report.datasetId).filter(e=>e.blockNumber<=report.asOfBlock);
      const ended=events.filter(e=>['ConsumptionRejected','ConsumptionCancelled'].includes(e.name));assert.equal(ended.length,2);
      for(const end of ended){const request=events.find(e=>e.name==='ConsumptionRequested'&&e.args.id===end.args.id)!;assert.ok(request&&end.timestamp<Number(request.args.expiresAt));}
      add('请求 #2 被会员拒绝、#3 被商家取消时均未到请求到期时间。因此原稿中“有效期到期”的替代解释不采用；具体线下原因仍未知。取消请求的权限属于商家，不应归给会员。',ended.map(e=>e.id).concat(state?[state]:[]));
      add('退款只退还尚未消费的额度，不撤销已确认消费。已实际观察到成功退款，但不能保证未来退款或线下履约。',[state,metric]);
      excludedHypotheses=[1];
    }else if(role==='local-anomaly'){
      const m=evidence.find(e=>e.id===metric)?.facts.metrics as any;assert.ok(['R1','R2','R4'].every(rule=>m.alerts.some((a:any)=>a.ruleId===rule)));
      add('密集确认触发的是 R4 固定规则，不是与该会员历史习惯的统计比较。因此“远超常态”缺少历史基线支持。GYM 在本项目不提供现金兑换，“以兑换现金为目的”的推测也没有证据，不采用该条异常假设。',[metric]);
      add('正确顺序为改收款地址后提现；提现仅减少已结算收入，未消费权益仍由托管资产覆盖。符合合约权限和额度不等于现实经营合法，也不证明实际到店。',[state,...report.toolRuns.filter(t=>t.name==='get_payout_timeline'&&t.status==='ok').flatMap(t=>t.evidenceIds).slice(0,3)]);
      excludedHypotheses=[1];
    }else if(role==='mainnet-control'){
      const m=evidence.find(e=>e.id===metric)?.facts.metrics as any;assert.equal(m.baseline.days,7);assert.equal(m.flags.length,0);
      add('大额样本仅用于发现候选；指标使用已保存完整窗口，对评估日与七日基线采用相同口径。原稿把金额增长归因于候选采样的假设不采用。零金额日志可影响笔数，但不能放大金额合计。第三方索引仍有遗漏和样本代表性风险。',[metric]);
      add('未查询不等于没有转出。实际补查仅覆盖所查询接收地址的锚点后最多 120 区块；金额接近与时序相邻不证明逐枚资金来源、现实身份或完整余额。规则未告警不等于安全。',report.toolRuns.filter(t=>t.name==='get_token_transfers'&&t.status==='ok').flatMap(t=>t.evidenceIds));
      excludedHypotheses=[2];
    }else{
      const hashes=report.toolRuns.filter(t=>t.name==='get_tx_evidence'&&t.status==='ok').map(t=>(t.arguments as any).txHash);
      const events=store.events(report.datasetId),window=report.analysis!.window!;
      assert.ok(hashes.length===2&&hashes.every(hash=>events.some(e=>e.txHash===hash&&e.timestamp>=window.from&&e.timestamp<window.to)));
      add('两笔 Agent 追加核验交易均位于评估日。原稿限制中“一笔基线转入”的时间归类不正确，以对应事件时间及收据区块为准。',report.toolRuns.filter(t=>t.name==='get_tx_evidence'&&t.status==='ok').flatMap(t=>t.evidenceIds));
      add('最大接收地址的窄窗口未见正数转出，不证明资金最终停留。另一地址的后续转出只说明该地址发生流动，不能认定转出的币逐枚来自本次入账。资金归集等原因仍是候选解释，不是已查明的现实原因。',[metric,...report.toolRuns.filter(t=>t.name==='get_token_transfers'&&t.status==='ok').flatMap(t=>t.evidenceIds)]);
    }
    for(const note of notes)for(const id of note.evidenceIds){const ev=evidence.find(e=>e.id===id);assert.ok(ev&&ev.asOfBlock<=report.asOfBlock&&ev.chainId===report.chainId);}
    for(const index of excludedHypotheses)assert.ok(report.hypotheses[index]);
    originals.push(report);updates.push({...report,review:{at,method:'development-evidence-review',notes,excludedHypotheses}});
    results.push({role,reportId:id,excludedHypotheses,notes});
  }
  // Back up before updating; retain model text and actual tool traces byte-for-byte.
  writeJSON('data/report-reviews/'+Date.now()+'.json',{at,originals});
  store.transaction(()=>{for(const report of updates)store.put('reports',report);});
  writeJSON('artifacts/acceptance/report-explanation-review.json',{at,passed:true,method:'development-evidence-review',results,scope:'Only these four frozen demo reports. Original AI text retained; excluded hypotheses must not be used. Not a second Agent or a guarantee of real-world risk.'});
  console.log(JSON.stringify({passed:true,reports:results.length,modelResponsesRewritten:0}));
}finally{store.close();}
