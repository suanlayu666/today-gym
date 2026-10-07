import type {Dataset,ChainEvent} from '../shared/types.ts';
import {basisPoints,transferMetrics} from './rules.ts';

// Fixed before case collection. Descriptive anomalies, not predictions of fraud.
export const MAINNET_RULE={version:'usdc-flow-v1',baselineDays:7,minRawAmount:'100000000000',growthBps:'50000',singleConcentrationBps:'8000'} as const;
export function mainnetMetrics(ds:Dataset,events:ChainEvent[],window=ds.analysisWindow){
  if(!ds.target||!window)throw new Error('Explicit target and full daily window required');
  if(window.to-window.from!==86400)throw new Error('A full UTC day is required');
  const baselineDays=ds.baselineDays??7;if(baselineDays<7)throw new Error('At least seven baseline days required');
  const daily=Array.from({length:baselineDays},(_,i)=>transferMetrics(events,ds.target!,window.from-(baselineDays-i)*86400,window.from-(baselineDays-i-1)*86400));
  const current=transferMetrics(events,ds.target,window.from,window.to),sum=daily.reduce((n,d)=>n+BigInt(d.total),0n);
  const growth=basisPoints(BigInt(current.total)*BigInt(baselineDays),sum),countSum=daily.reduce((n,d)=>n+BigInt(d.count),0n);
  const minimum=BigInt(current.total)>=BigInt(MAINNET_RULE.minRawAmount),flags:string[]=[];
  if(minimum&&growth!==null&&BigInt(growth)>=BigInt(MAINNET_RULE.growthBps))flags.push('MAIN_GROWTH');
  if(minimum&&current.singleConcentrationBps!==null&&BigInt(current.singleConcentrationBps)>=BigInt(MAINNET_RULE.singleConcentrationBps))flags.push('MAIN_CONCENTRATION');
  return {rule:MAINNET_RULE,unit:'raw token units',decimals:ds.decimals,current,baseline:{days:baselineDays,from:daily[0].from,to:window.from,daily,total:sum.toString(),meanNumerator:sum.toString(),meanDenominator:String(baselineDays),count:countSum.toString()},relativeTotalBps:growth,relativeCountBps:basisPoints(BigInt(current.count)*BigInt(baselineDays),countSum),flags,limitations:['零基线的相对变化不可计算，不输出无穷倍。','候选从大额交易样本中选取，有选择偏差，不是独立预测验证。','集中转账可能是正常资金归集；链上无法单独证明现实身份或经营意图。']};
}
