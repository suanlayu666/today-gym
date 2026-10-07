import type {Alert,ChainEvent,Dataset,Report} from '../../shared/types.ts';
export {pendingRequests,confirmedToday} from '../../shared/business.ts';

export function preferredGym(datasets:Dataset[]){
  return datasets.find(d=>d.adapter==='gym'&&d.dataOrigin==='local-chain'&&d.caseRole!=='anomaly'&&!/异动|异常/.test(d.name))
    ??datasets.find(d=>d.adapter==='gym'&&d.caseRole!=='anomaly')??datasets.find(d=>d.adapter==='gym');
}
export function isManagementRoute(route:string){return ['/admin','/investigations','/cases'].includes(route)||route.startsWith('/reports/');}
const businessNames=new Set(['Deposited','Refunded','ConsumptionRequested','ConsumptionConfirmed','ConsumptionRejected','ConsumptionCancelled','ConsumptionExpired','Withdrawn','PayoutAddressChanged']);
export function memberEvents(events:ChainEvent[],account:string){
  if(!account)return [];
  return events.filter(e=>businessNames.has(e.name)&&e.args.user?.toLowerCase()===account.toLowerCase());
}
export function fundingStatus(snapshot:any,ready:boolean){
  if(!ready||!snapshot||![snapshot.assets,snapshot.userCredit,snapshot.revenue].every(v=>typeof v==='string'&&/^\d+$/.test(v)))return {tone:'neutral',title:'资金状态暂时无法核查',text:'正在获取可靠记录。暂时不能判断资金是否覆盖，请稍后重试。'};
  const assets=BigInt(snapshot.assets),owed=BigInt(snapshot.userCredit)+BigInt(snapshot.revenue);
  return assets>=owed
    ?{tone:'good',title:'未消费额度有托管资产覆盖',text:'最近核对的账目显示，未消费额度有足够资产覆盖。老板只能拿走已确认消费的收入；这不保证线下履约。'}
    :{tone:'attention',title:'托管资产不足，需要核查',text:'最近账目显示托管资产低于应保留的额度。请先核对记录，再决定是否继续充值；这不等于已认定商家跑路。'};
}
const alertCopy:Record<string,{title:string;text:string;action:string}>={
  R1:{title:'商家近期集中提现',text:'近期提取了较大比例的已结算收入，值得核对用途。提现本身不能证明跑路。',action:'核对近期消费是否本人确认，未使用的额度仍可申请退回。'},
  R2:{title:'商家更换收款账户后提现',text:'收款账户变更后发生提现，建议核实新的收款安排。',action:'如不认识该变更，可联系商家确认。'},
  R4:{title:'出现密集消费确认',text:'同一会员在一天内多次确认消费，达到系统提示阈值。',action:'检查这些服务是否实际完成，不要确认未使用的服务。'},
  R6:{title:'托管额度需要进一步核对',text:'系统发现资产与应保留额度不一致，正在等待核查。',action:'在核对清楚前谨慎充值，不把提醒当作犯罪结论。'},
  ADDRESS_INFO:{title:'商家更新了收款账户',text:'收款安排有变化，系统已保留记录。',action:'如有疑问，可向商家核实。'}
};
export function usefulAlerts(alerts:Alert[],account:string,merchant=false){
  return alerts.filter(a=>a.ruleId!=='R4'||merchant||!!account&&a.metrics.user?.toLowerCase()===account.toLowerCase()).map(a=>({...a,copy:alertCopy[a.ruleId]??{title:'有一项记录需要核对',text:'系统发现值得关注的变化，尚不能确定原因。',action:'查看依据或联系商家确认。'}}));
}
export function usableReport(reports:Report[],datasetId:string,cutoff?:number){
  return reports.filter(r=>r.datasetId===datasetId&&r.mode==='llm'&&r.status==='complete'&&cutoff!==undefined&&r.asOfBlock<=cutoff).sort((a,b)=>b.generatedAt.localeCompare(a.generatedAt))[0];
}
export function investigationNotice(ready:boolean,active:boolean,lastJob:any,report:Report|undefined,enabled:boolean){
  if(!ready)return '核查暂时无法更新。';
  if(active)return 'AI 正在后台核查新变化，你可以继续使用其他功能。';
  if(lastJob&&['partial','failed'].includes(lastJob.status))return '最近一次 AI 核查未完成，当前提醒不能当作完整调查结论。';
  if(report)return '已有 AI 核查结果，详细判断和依据可按需查看。';
  return enabled?'新异常会由 AI 在后台核查。':'自动 AI 核查未开启，目前展示账目与规则提醒。';
}
