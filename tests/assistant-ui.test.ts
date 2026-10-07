import test from 'node:test';
import assert from 'node:assert/strict';
import {investigationQuestion,assistantReply,starterQuestions} from '../web/src/assistant.ts';
import type {Report} from '../shared/types.ts';

test('assistant questions are role scoped, bounded, independent and require evidence',()=>{
  const member=investigationQuestion(' 我的额度还在吗？ ','member');
  assert.match(member,/会员/);assert.match(member,/当前健身房链上记录/);assert.match(member,/每次提问独立调查/);assert.match(member,/不认定跑路/);
  assert.match(investigationQuestion('a'.repeat(800),'merchant'),/商家/);
  assert.ok(investigationQuestion('a'.repeat(800),'merchant').length<=1000);
  assert.ok(investigationQuestion('a'.repeat(800),'member','0x'+'a'.repeat(40)).length<=1000);
  assert.match(investigationQuestion('我的额度','member','0x'+'a'.repeat(40)),/区分本人额度与健身房总额/);
  assert.throws(()=>investigationQuestion('额度','member','不是钱包'));
  assert.throws(()=>investigationQuestion('  ','member'));assert.throws(()=>investigationQuestion('a'.repeat(801),'member'));
  assert.equal(starterQuestions.member.length,3);assert.equal(starterQuestions.merchant.length,3);
});
test('failed/rule reports cannot be presented as successful AI answers; corrections take priority',()=>{
  const report={mode:'llm',status:'complete',consumerImpact:'基于证据的影响',headline:'报告'} as Report;
  assert.equal(assistantReply(report),'基于证据的影响');
  assert.match(assistantReply({...report,status:'partial'}),/没有完成/);
  assert.match(assistantReply({...report,mode:'rule-only'}),/没有完成/);
  assert.match(assistantReply({...report,review:{at:'now',method:'development-evidence-review',notes:[{text:'原稿有时间错误',evidenceIds:[]}],excludedHypotheses:[]}}),/复核更正/);
});
