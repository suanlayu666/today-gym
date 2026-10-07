import type {FlowDeployment,FlowEvent,FlowMetrics} from '../shared/flow.ts';
const eq=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
const sum=(events:FlowEvent[])=>events.reduce((n,e)=>n+BigInt(e.amount),0n);
const ratio=(n:bigint,d:bigint)=>d>0n?(n*10000n/d).toString():null;
export function flowMetrics(d:FlowDeployment,events:FlowEvent[],event:FlowEvent):FlowMetrics{
  const ordered=events.filter(e=>e.blockNumber<event.blockNumber||e.blockNumber===event.blockNumber&&e.logIndex<=event.logIndex).sort((a,b)=>a.blockNumber-b.blockNumber||a.logIndex-b.logIndex);
  const window=ordered.filter(e=>e.timestamp>=event.timestamp-86400);
  const receipts=window.filter(e=>eq(e.to,d.accounts.merchant)&&!eq(e.from,d.accounts.merchant));
  const outflows=window.filter(e=>eq(e.from,d.accounts.merchant)&&!eq(e.to,d.accounts.merchant));
  const baseline=ordered.filter(e=>e.id!==event.id&&e.kind===event.kind&&BigInt(e.amount)>0n).slice(-20);
  const sorted=baseline.map(e=>BigInt(e.amount)).sort((a,b)=>a<b?-1:a>b?1:0);
  const median=sorted.length?sorted.length%2?sorted[Math.floor(sorted.length/2)]:(sorted[sorted.length/2-1]+sorted[sorted.length/2])/2n:null;
  const totals=new Map<string,bigint>();for(const e of outflows)totals.set(e.to.toLowerCase(),(totals.get(e.to.toLowerCase())||0n)+BigInt(e.amount));
  const top=[...totals].sort((a,b)=>a[1]>b[1]?-1:a[1]<b[1]?1:0)[0];
  const incoming=sum(receipts),outgoing=sum(outflows),amountRatio=baseline.length>=3&&median!==null?ratio(BigInt(event.amount),median):null;
  const previousReceipt=ordered.filter(e=>e.id!==event.id&&eq(e.to,d.accounts.merchant)&&!eq(e.from,d.accounts.merchant)).at(-1);
  const delay=eq(event.from,d.accounts.merchant)&&previousReceipt?event.timestamp-previousReceipt.timestamp:null;
  const outflowRatio=ratio(outgoing,incoming),concentration=top?ratio(top[1],outgoing):null;
  const flags:string[]=[];
  if(amountRatio!==null&&BigInt(amountRatio)>=30000n)flags.push('单笔金额达到此前同类记录中位数的三倍');
  if(eq(event.from,d.accounts.merchant)&&outflowRatio!==null&&BigInt(outflowRatio)>=8000n)flags.push('近24小时转出达到收款的80%或以上');
  if(eq(event.from,d.accounts.merchant)&&concentration!==null&&BigInt(concentration)>=8000n&&outflows.length>=3)flags.push('近24小时转出接收方高度集中');
  if(delay!==null&&delay<=300)flags.push('收款后五分钟内出现转出');
  return {version:'direct-flow-quant-v1',window:{from:event.timestamp-86400,to:event.timestamp,seconds:86400},eventAmount:event.amount,baselineCount:baseline.length,baselineMedian:median?.toString()??null,amountVsMedianBps:amountRatio,receipts:incoming.toString(),outflows:outgoing.toString(),netInflow:(incoming-outgoing).toString(),outflowToReceiptBps:outflowRatio,recipientConcentrationBps:concentration,topRecipient:top?.[0]??null,secondsSinceLastReceipt:delay,flags,limitations:[...(baseline.length<3?['同类历史样本不足三笔，不计算金额异常倍数。']:[]),...(incoming===0n?['窗口内没有收款，转出/收款比无法计算。']:[]),'只反映已采集的当前币种与部署后窗口，不是商家全部资产或全部负债。','规则信号不等于跑路、违法或线下服务停止；正常成本支付也可能触发。']};
}
export function classifyFlow(d:FlowDeployment,from:string,to:string):FlowEvent['kind']{
  if(eq(from,d.accounts.merchant))return 'withdrawal';
  if(eq(to,d.accounts.merchant))return [d.accounts.userA,d.accounts.userB].some(a=>eq(a,from))?'payment':'receipt';
  if([d.accounts.userA,d.accounts.userB].some(a=>eq(a,from)||eq(a,to)))return 'member-transfer';
  return 'recipient-transfer';
}
