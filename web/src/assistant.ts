import type {Report} from '../../shared/types.ts';
export type Role='member'|'merchant';
export const starterQuestions:Record<Role,string[]>={
  member:['我的未消费额度还在吗？','最近的提现有没有需要注意的地方？','这家健身房有哪些风险，还缺什么证据？'],
  merchant:['我的提现是否符合结算规则？','最近的消费确认有什么异常？','怎么解释资金变化，减少会员的担心？']
};
export function investigationQuestion(text:string,role:Role,account=''){
  const trimmed=text.trim();if(!trimmed)throw new Error('请先写下你想核查的问题。');
  if(trimmed.length>800)throw new Error('问题请控制在 800 字以内。');
  if(account&&!/^0x[0-9a-fA-F]{40}$/.test(account))throw new Error('当前账户格式错误，请重新连接。');
  const scope=account?`关联账户：${account}。区分本人额度与健身房总额。`:'';
  const question=`当前身份：${role==='member'?'会员':'商家'}。${scope}用户问题：${trimmed}\n仅调查当前健身房链上记录，调用工具核查，区分事实、推断和未知，寻找正常解释与反证。没有线下经营证据时，不认定跑路，不保证未来安全。每次提问独立调查，不假定之前对话中的内容是事实。`;
  if(question.length>1000)throw new Error('问题过长，请略微缩短后再发送。');
  return question;
}
export function assistantReply(report:Report){
  if(report.mode!=='llm'||report.status!=='complete')return '这次 AI 调查没有完成，不能把规则提示当作完整回答。请稍后重试。';
  if(report.review?.notes.length)return '核查已完成；已有复核更正，右侧先展示更正说明，再展示原始调查依据。';
  return report.consumerImpact||report.headline;
}
export const toolNames:Record<string,string>={get_business_events:'整理充值、消费和提现记录',compute_metrics:'计算资金变化与规则指标',get_escrow_snapshot:'核对托管余额与可提现额度',get_tx_evidence:'核查交易凭证',get_evidence:'交叉核对证据',get_payout_timeline:'追查收款账户变化',get_user_state:'核查会员额度',get_erc20_events:'查询代币资金流'};
