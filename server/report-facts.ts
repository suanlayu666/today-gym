import {formatUnits} from 'ethers';
import type {Dataset,Evidence,Report,ToolRun} from '../shared/types.ts';

export const FACT_VERSION='evidence-facts-v1';
// Factual statements are deterministic projections of actual successful tools.
// The LLM writes hypotheses/inferences/unknowns, not balances or receipt facts.
export function verifiedFacts(ds:Dataset,evidence:Evidence[],runs:ToolRun[],cutoff:number):Report['findings']{
  const refs=new Set(runs.filter(r=>r.status==='ok').flatMap(r=>r.evidenceIds));
  const used=evidence.filter(e=>refs.has(e.id)&&e.datasetId===ds.id&&e.chainId===ds.chainId&&e.asOfBlock<=cutoff).sort((a,b)=>a.asOfBlock-b.asOfBlock||a.id.localeCompare(b.id));
  const usedFor=(name:string)=>{const ids=new Set(runs.filter(r=>r.status==='ok'&&r.name===name).flatMap(r=>r.evidenceIds));return used.filter(e=>ids.has(e.id));};
  const findings:Report['findings']=[],amount=(n:unknown)=>formatUnits(String(n),ds.decimals)+' '+ds.tokenSymbol;
  const fact=(text:string,ev:Evidence)=>findings.push({text,type:'fact',evidenceIds:[ev.id]});
  const metric=usedFor('compute_metrics').find(e=>e.facts.metrics);
  if(ds.adapter==='erc20'&&metric){const m=metric.facts.metrics as any,display=metric.facts.display as any;
    fact('评估窗口内目标转出合计 '+amount(m.current.total)+'，转出日志 '+m.current.count+' 条（含零金额日志），最大单笔 '+amount(m.current.maxSingle)+'。此前 '+m.baseline.days+' 个完整 UTC 日合计 '+amount(m.baseline.total)+'。',metric);
    fact('规则版本 '+m.rule.version+'；实际 flags：'+(m.flags.length?m.flags.join('、'):'空数组，无规则告警')+'。相对日均倍数 '+(display?.relativeTotalRatio??'不可计算')+'，比较方向：'+(display?.currentVersusDailyMean??'未知')+'；单笔集中度 '+m.current.singleConcentrationBps+' bps，合计最大接收方 '+(m.current.topRecipient??'无')+'。公式及阈值见程序附件。',metric);
  }
  if(ds.adapter==='gym'){const state=usedFor('get_escrow_snapshot').find(e=>e.kind==='state'&&e.facts.assets!==undefined);if(state)fact('截止区块托管资产 '+amount(state.facts.assets)+'，会员未消费负债 '+amount(state.facts.userCredit)+'，商家已结算待提现收入 '+amount(state.facts.revenue)+'。这是链上状态，不证明线下实际履约。',state);}
  for(const ev of usedFor('get_tx_evidence').filter(e=>e.kind==='transaction'))fact('本次追加在线核验的交易位于区块 #'+ev.facts.blockNumber+'，收据状态 '+ev.facts.status+'；交易发送方 '+ev.facts.from+'，调用目标 '+ev.facts.to+'。代币接收方需查看收据日志，不等于调用目标；哈希、输入与日志见证据。',ev);
  for(const ev of usedFor('get_token_transfers').filter(e=>e.facts.followup)){const f=ev.facts.followup as any;fact('接收地址 '+f.address+' 在补查区块 #'+f.fromBlock+'–#'+f.toBlock+' 内本 token 转出合计 '+amount(f.totalRaw)+'，共 '+f.count+' 条转出日志，其中 '+f.positiveCount+' 条正数、'+(f.count-f.positiveCount)+' 条零金额。仅观察接收锚点后最多120区块，不是全天、完整余额或逐枚资金归属追踪。',ev);}
  if(!findings.length)throw new Error('Incomplete deterministic fact evidence');
  return findings;
}
export const orderedFacts=(facts:Report['findings'])=>[...facts].sort((a,b)=>a.text.localeCompare(b.text));
