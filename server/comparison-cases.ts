import {flowMetrics} from './flow-metrics.ts';
import type {FlowDeployment,FlowEvent} from '../shared/flow.ts';
import type {ComparisonCase} from '../shared/research.ts';
const address=(n:number)=>'0x'+n.toString(16).padStart(40,'0');
const d:FlowDeployment={id:'synthetic-comparison',chainId:31337,dataOrigin:'local-chain',token:address(8),tokenSymbol:'GYM',decimals:0,deploymentBlock:0,deploymentHash:'0x'+'0'.repeat(64),accounts:{merchant:address(1),userA:address(2),userB:address(3),payout:address(4),nextPayout:address(5)}};
function events(rows:{amount:string;withdrawal?:boolean;time:number;recipient?:number}[]):FlowEvent[]{return rows.map((r,i)=>({id:'synthetic-'+i,txHash:'0x'+String(i+1).padStart(64,'0'),blockHash:'0x'+String(i+1).padStart(64,'0'),logIndex:0,blockNumber:i+1,timestamp:r.time,from:r.withdrawal?d.accounts.merchant:d.accounts.userA,to:r.withdrawal?address(r.recipient??4):d.accounts.merchant,amount:r.amount,kind:r.withdrawal?'withdrawal':'payment'}));}
export function comparisonCases():ComparisonCase[]{
  const cases=[
    {id:'steady',title:'常规收支：没有规则提醒',rows:[{amount:'1000',time:100000},{amount:'100',withdrawal:true,time:101000},{amount:'100',withdrawal:true,time:102000,recipient:5},{amount:'100',withdrawal:true,time:103000,recipient:6},{amount:'100',withdrawal:true,time:104000}],ruleResult:'累计转出低于本次演示阈值，单笔金额接近此前记录。',normalExplanation:'可能是分批支付正常经营成本，但样例没有提供发票或经营凭证。',investigationQuestion:'是否偏离历史习惯？没有提醒，能否代表商家安全？',unknowns:'线下是否营业、是否存在其他资产或负债均未知。',expected:'暂未发现规则信号，不等于正常经营已被证实。'},
    {id:'clustered',title:'多项信号：需要核实用途',rows:[{amount:'1000',time:100000},{amount:'300',withdrawal:true,time:100060},{amount:'300',withdrawal:true,time:100120},{amount:'300',withdrawal:true,time:100180}],ruleResult:'高转出比例、接收方集中、收款后快速转出同时出现。',normalExplanation:'集中支付房租或供应商费用也可能出现这些信号。',investigationQuestion:'接收账户是否长期往来？后续是否继续转出？有哪些证据可以支持或削弱不同解释？',unknowns:'接收方现实身份、付款用途、窗口外后续行为未知。',expected:'建议进一步核实，不输出跑路概率或犯罪结论。'},
    {id:'short-history',title:'高比例但记录少：证据不足',rows:[{amount:'1000',time:100000},{amount:'900',withdrawal:true,time:104000}],ruleResult:'转出占收款九成，但只有一笔可观察转出，没有金额历史基线。',normalExplanation:'一笔周期性结算也可能产生高比例，不能只按比例下结论。',investigationQuestion:'有没有历史对照？可否核验收据和真实用途？缺失证据时应该如何表达？',unknowns:'同类历史记录不足，无法可靠判断金额是否反常；真实用途未知。',expected:'说明需要核实，同时保留原因无法判断。'},
  ];
  return cases.map(c=>{const es=events(c.rows);const {rows,...text}=c;return {...text,origin:'synthetic' as const,metrics:flowMetrics(d,es,es.at(-1)!)};});
}
