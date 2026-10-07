import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {ConsumerScreen,MerchantScreen} from '../web/src/flow-screens.tsx';
import {AgentConversation} from '../web/src/agent-conversation.tsx';
import {accountEvents,accountTotals,viewFromPath,percentBps} from '../shared/flow-view.ts';
import type {FlowDeployment,FlowEvent,FlowOverview} from '../shared/flow.ts';
const address=(n:number)=>'0x'+n.toString(16).padStart(40,'0');
const d:FlowDeployment={id:'test',chainId:31337,dataOrigin:'local-chain',token:address(8),tokenSymbol:'GYM',decimals:0,deploymentBlock:1,deploymentHash:'hash',accounts:{merchant:address(1),userA:address(2),userB:address(3),payout:address(4),nextPayout:address(5)}};
const event=(id:string,from:string,to:string,amount:string,n:number):FlowEvent=>({id,from,to,amount,blockNumber:n,logIndex:0,timestamp:100000+n,txHash:'hash'+n,blockHash:'block'+n,kind:'payment'});
const events=[event('a',address(2),address(1),'137',1),event('b',address(3),address(1),'863',2),event('out',address(1),address(4),'900',3),event('hop',address(4),address(5),'1',4)];
const data:FlowOverview={version:'direct-flow-v1',ready:true,deployment:d,balances:{userA:'29863',userB:'29137',merchant:'100',payout:'899',nextPayout:'1'},events,jobs:[],reports:[],totalEvents:4,modelConfigured:true,automaticAnalysis:true,signingEnabled:true};
test('三个入口独立，旧调查入口映射分析栏',()=>{assert.equal(viewFromPath('/consumer'),'consumer');assert.equal(viewFromPath('/merchant'),'merchant');assert.equal(viewFromPath('/analysis'),'analysis');assert.equal(viewFromPath('/investigations'),'analysis');});
test('会员只看到自己的账单，不混入别人的付款或商家转出',()=>{assert.deepEqual(accountEvents(events,d,'userA').map(e=>e.id),['a']);assert.deepEqual(accountEvents(events,d,'userB').map(e=>e.id),['b']);});
test('商家只看到经营账户收支，不混入接收地址后续转账',()=>{assert.deepEqual(accountEvents(events,d,'merchant').map(e=>e.id),['out','b','a']);assert.deepEqual(accountTotals(events,d.accounts.merchant),{incoming:'1000',outgoing:'900'});});
test('会员与商家页面不渲染 Agent、量化指标、工具调用或原始 JSON',()=>{const consumer=renderToStaticMarkup(createElement(ConsumerScreen,{data,role:'userA',form:createElement('button',null,'付款'),onAnalyze:()=>{}}));const merchant=renderToStaticMarkup(createElement(MerchantScreen,{data,form:createElement('button',null,'转出资金'),onAnalyze:()=>{}}));for(const page of [consumer,merchant])for(const text of ['DeepSeek','Agent','量化','工具调用','区块','<pre>'])assert.equal(page.includes(text),false,text+' 不应出现在业务页面');assert.ok(consumer.includes('−137'));assert.equal(consumer.includes('+863'),false);assert.equal(consumer.includes('−900'),false);assert.ok(merchant.includes('−900'));assert.equal(merchant.includes('关联收款账户'),false);});
test('比例展示保持精度，缺分母明确无法计算',()=>{assert.equal(percentBps('8991'),'89.91%');assert.equal(percentBps(null),'无法计算');});
test('提问首屏只有人物、输入与示例，不提前展示历史报告或伪造回答',()=>{
  const html=renderToStaticMarkup(createElement(AgentConversation,{data,event:events[2],unavailable:false,onAsk:async()=>{throw new Error('SSR 不应提交调查');}}));
  for(const text of ['gym-companion.png','向智能体提问','示例问题','本次锚点','900 GYM','截至该笔记录的前 24 小时','后台自动核查保持开启'])assert.ok(html.includes(text),text);
  for(const text of ['conversation-answer','<pre>','独立复核 Agent','跑路概率'])assert.equal(html.includes(text),false,text);
});
test('没有账单或模型时输入入口解释限制，不声称可以调查',()=>{
  const html=renderToStaticMarkup(createElement(AgentConversation,{data:{...data,events:[],modelConfigured:false},unavailable:false,onAsk:async()=>{throw new Error('不得调用');}}));
  assert.ok(html.includes('还没有可调查的账单'));assert.ok(html.includes('模型尚未连接'));assert.ok(html.includes('disabled=""'));
});
