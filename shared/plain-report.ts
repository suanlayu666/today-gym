import type {FlowEvent,FlowJob,FlowReport} from './flow.ts';
import {percentBps} from './flow-view.ts';

export type PlainReport={tone:'neutral'|'attention'|'unknown';label:string;title:string;happened:string;reasons:string[];nextStep:string;boundary:string;checkedAt:string|null};
export function conversationalReport(report:FlowReport,question:string){
  const m=report.metrics;
  const summary=report.risk==='disputed'?'两次检查的意见不一致，现在还不能下结论。':report.risk==='insufficient'?'发现了一些需要问清楚的地方，但信息还不够，暂时判断不了原因。':report.risk==='no-signal'?'这次没有发现明显异常，但不代表商家一定安全。':'有几处变化值得问问商家，但还不能说商家要跑路。';
  const changes:string[]=[];
  if(/24|收款|比例|变化/.test(question))changes.push(`截至这笔账单，前 24 小时收到 ${m.receipts} GYM，转出 ${m.outflows} GYM。`);
  if(m.flags.some(f=>f.includes('接收方高度集中')))changes.push('转出的钱主要去了同一个账户，需要问清这个账户是做什么的。');
  if(m.flags.some(f=>f.includes('五分钟')))changes.push('有收款后很快又转钱的情况，需要了解支出用途。');
  if(m.flags.some(f=>f.includes('三倍')))changes.push('这笔转出比之前常见的金额大不少，需要问问为什么。');
  if(/追踪|哪里|转出去之后/.test(question)){
    const trace=report.stages.flatMap(s=>s.toolRuns).find(t=>t.name==='trace_recipient'&&t.status==='ok');
    const data=trace?.result as {transfers?:unknown[]}|undefined;
    const detail=Array.isArray(data?.transfers)?data.transfers.length?`查到收钱的账户又转出了 ${data.transfers.length} 笔，具体去向可以展开依据查看。`:'这次查到的范围内，没有发现收钱的账户继续转账。':'这次还没有拿到可靠的后续转账结果。';
    return {summary,details:detail+'这里只查了有限范围，不能把没查到当作没有转账。',nextStep:'先问商家：收钱的账户是谁在用，这笔钱用来做什么？'};
  }
  if(/正常.*解释|经营.*可能解释/.test(question))return {summary,details:'付房租、发工资，或者把钱集中到经营账户，都有可能。但目前没有凭证，不能当作已经查明的原因。',nextStep:'请商家说明用途，并提供对应账单或付款凭证。'};
  return {summary,details:changes.slice(0,3).join(' ')||'目前还不能从这些记录里确认资金用途。',nextStep:'先问商家：这些钱转去做什么？能否提供支出凭证？'};
}
export function plainReport(event:FlowEvent,report:FlowReport|undefined,job:FlowJob|undefined,fromName:string,toName:string):PlainReport{
  const happened=event.kind==='payment'?`${fromName}向健身房支付了 ${event.amount} GYM，这笔付款已确认。`:event.kind==='receipt'?`健身房收到 ${event.amount} GYM，这笔收款已确认。`:`${fromName}转出了 ${event.amount} GYM，接收方是${toName}。`;
  const base:PlainReport={tone:'unknown',label:'等待检查',title:'这笔记录还没有检查结果',happened,reasons:[],nextStep:'稍后回来查看结果，也可以发起一次检查。',boundary:'这里只能核查已记录的资金变动，不能据此判断商家会不会关门。',checkedAt:report?.generatedAt??null};
  if(report?.status==='stale'||job?.status==='stale')return {...base,label:'旧结果已过期',title:'这份旧结果不能代表当前情况',reasons:['用于检查的记录已经变化，需要重新核实。'],nextStep:'重新检查后，再查看新的结果。'};
  if(report?.status==='partial'||job?.status==='partial')return {...base,label:'检查未完成',title:'检查还没有完成，暂时不能给出判断',reasons:['付款或转出是否完成，与风险检查是否完成是两回事。此次检查未能完整结束，不代表资金没有风险。'],nextStep:'稍后重新检查，或直接向商家核实资金用途。'};
  if(!report||report.status!=='complete')return {...base,label:job?'正在检查':'等待检查',title:job?'正在检查这笔记录，请稍等':'这笔记录还没有检查结果',reasons:[job?'检查结果会自动更新，现在还不能下结论。':'尚未进行检查，不能把没有结果当作安全。']};
  const m=report.metrics,reasons:string[]=[];
  if(m.flags.some(f=>f.includes('转出达到收款')))reasons.push(`截至这笔记录，24 小时内健身房收款 ${m.receipts} GYM、转出 ${m.outflows} GYM，转出占收款的 ${percentBps(m.outflowToReceiptBps)}。需要关注的是累计转出比例，不能只看这一笔的金额。`);
  if(m.flags.some(f=>f.includes('接收方高度集中')))reasons.push('多笔转账主要流向同一个账户，需要了解该账户的用途。');
  if(m.flags.some(f=>f.includes('五分钟')))reasons.push('健身房收到付款后，很快又转出了资金，需要核实是否为正常经营支出。');
  if(m.flags.some(f=>f.includes('三倍')))reasons.push('这笔金额达到此前同类转账常见金额的三倍或以上，需要了解金额增加的原因。');
  const state=report.risk;
  const presentation={
    attention:{tone:'attention' as const,label:'建议核实用途',title:m.flags.some(f=>f.includes('转出达到收款'))?'健身房近期转出比例偏高，建议核实用途':'这笔资金变动需要进一步核实',nextStep:'向商家了解相关支出的用途，并要求提供相应说明。'},
    disputed:{tone:'unknown' as const,label:'暂时没有一致判断',title:'对这笔记录存在不同解释，需要再核实',nextStep:'先核实资金用途，等进一步检查后再作判断。'},
    insufficient:{tone:'unknown' as const,label:'目前无法判断',title:'现有信息还不够，暂时不能判断原因',nextStep:'向商家核实资金用途，待补充更多信息后重新检查。'},
    'no-signal':{tone:'neutral' as const,label:'暂未发现明显异常',title:'这次检查没有发现明确的异常信号',nextStep:'留意后续提醒；这次结果不是商家安全或正常营业的保证。'},
  }[state];
  if(!reasons.length)reasons.push(state==='no-signal'?'在这次检查的记录范围内，没有发现明确的资金异常。':'目前缺少足够的资金用途和经营信息，不能确定变化的原因。');
  if(m.baselineCount<3)reasons.push('可比较的同类记录太少，暂时不能可靠判断这笔金额是否反常。');
  return {...base,...presentation,reasons};
}
export function plainReportText(summary:PlainReport){return ['今天链不练 · 简明检查结果',summary.label,summary.title,'','发生了什么',summary.happened,'','为什么这样提醒',...summary.reasons.map(s=>'• '+s),'','接下来怎么办',summary.nextStep,'',summary.boundary,...(summary.checkedAt?['检查时间：'+new Date(summary.checkedAt).toLocaleString('zh-CN')]:[]),'GYM 是无现金价值的演示币。本地演示不代表已接入公共以太坊。'].join('\n');}
