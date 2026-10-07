import React,{useEffect,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {getAddress,ZeroAddress} from 'ethers';
import type {FlowOverview,FlowStage,FlowJob} from '../../shared/flow';
import {viewFromPath,percentBps,type FlowView,type PaymentRole} from '../../shared/flow-view';
import {ConsumerScreen,MerchantScreen,accountLabel,shortAddress} from './flow-screens';
import {plainReport} from '../../shared/plain-report';
import {PlainReportCard} from './plain-report';
import {ResearchPanel} from './research';
import {AgentConversation} from './agent-conversation';
import './flow.css';
import './atmosphere.css';
import './conversation.css';

async function api<T>(path:string,body?:unknown):Promise<T>{const r=await fetch('/api/flow'+path,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(90000)});const j=await r.json();if(!r.ok)throw new Error(j.error?.message||'操作未完成，请稍后重试。');return j.data;}
const jobStatus:Record<string,string>={queued:'等待调查',investigating:'调查员正在取证',reviewing:'复核员独立核查',complete:'核查完成',partial:'核查未完成',stale:'历史已失效'};
const toolLabel:Record<string,string>={list_events:'读取资金流水',compute_metrics:'重算量化指标',verify_transaction:'核对交易收据',trace_recipient:'追踪接收账户'};
function App(){
  const [view,setView]=useState<FlowView>(()=>viewFromPath(location.pathname)),[role,setRole]=useState<PaymentRole>(()=>viewFromPath(location.pathname)==='merchant'?'merchant':'userA');
  const [data,setData]=useState<FlowOverview>(),[connectionError,setConnectionError]=useState('');
  const [amount,setAmount]=useState(''),[to,setTo]=useState(''),[confirm,setConfirm]=useState(false),[transferPending,setTransferPending]=useState(false),[transferError,setTransferError]=useState(''),[transferMessage,setTransferMessage]=useState('');
  const [selected,setSelected]=useState(''),[chosenJob,setChosenJob]=useState(''),[analysisError,setAnalysisError]=useState(''),[analysisMessage,setAnalysisMessage]=useState('');
  const transferLock=useRef(false),lastMember=useRef<'userA'|'userB'>('userA'),requests=useRef(new Map<string,string>());
  const [retryPending,setRetryPending]=useState(false);const retryLock=useRef(false);
  const refresh=async()=>{try{setData(await api<FlowOverview>(''));setConnectionError('');}catch{setConnectionError('服务暂时未连接，当前不能付款或转出。');}};
  useEffect(()=>{let stopped=false;let timer:ReturnType<typeof setTimeout>;const poll=async()=>{try{const d=await api<FlowOverview>('');if(!stopped){setData(d);setConnectionError('');}}catch{if(!stopped)setConnectionError('服务暂时未连接，当前不能付款或转出。');}if(!stopped)timer=setTimeout(poll,4000);};void poll();return()=>{stopped=true;clearTimeout(timer);};},[]);
  useEffect(()=>{const handle=()=>{const v=viewFromPath(location.pathname);setView(v);setRole(v==='merchant'?'merchant':lastMember.current);setConfirm(false);setTransferError('');setTransferMessage('');};window.addEventListener('popstate',handle);return()=>window.removeEventListener('popstate',handle);},[]);
  const d=data?.deployment,merchant=role==='merchant',destination=merchant?to.trim():d?.accounts.merchant||'';
  function navigate(next:FlowView,eventId?:string){if(transferLock.current)return;setView(next);history.pushState({},'', '/'+next);if(next==='merchant')setRole('merchant');if(next==='consumer')setRole(lastMember.current);setConfirm(false);setTransferError('');setTransferMessage('');if(eventId){setSelected(eventId);setChosenJob('');}}
  function switchRole(next:PaymentRole){if(transferLock.current)return;if(next!=='merchant')lastMember.current=next;setRole(next);setAmount('');setTo('');navigate(next==='merchant'?'merchant':'consumer');}
  const unavailable=!!connectionError||!data?.ready;
  let addressValid=false;try{const normalized=getAddress(destination);addressValid=normalized!==ZeroAddress&&normalized.toLowerCase()!==d?.accounts[role].toLowerCase();}catch{}
  const amountValid=/^[1-9]\d{0,29}$/.test(amount),balance=data?.balances?.[role],tooMuch=amountValid&&balance!==undefined&&BigInt(amount)>BigInt(balance);
  const canTransfer=!unavailable&&!!data?.signingEnabled&&addressValid&&amountValid&&!tooMuch;
  async function submit(){
    if(transferLock.current||!d||!canTransfer)return;transferLock.current=true;setTransferPending(true);setTransferError('');setTransferMessage('正在等待付款确认，请勿重复提交。');
    const key=role+':'+amount+':'+destination.toLowerCase();if(!requests.current.has(key))requests.current.set(key,crypto.randomUUID());
    try{const r=await api<{txHash:string;confirmed:boolean}>('/transfers',{role,amount,to:destination,requestId:requests.current.get(key)});setTransferMessage(r.confirmed?(merchant?'资金已转出，账单已更新。':'付款成功，账单已更新。'):'交易已提交但尚未确认，请先查看账单，不要重复付款。');if(r.confirmed){requests.current.delete(key);setAmount('');}setConfirm(false);await refresh();}catch(e){setTransferError((e as Error).message+' 原参数重试会复用请求编号。');setTransferMessage('');}finally{transferLock.current=false;setTransferPending(false);}
  }
  const events=data?.events||[],event=events.find(e=>e.id===selected)||events.at(-1),eventJobs=data?.jobs.filter(j=>j.eventId===event?.id)||[];
  const job=eventJobs.find(j=>j.id===chosenJob)||eventJobs.find(j=>j.status!=='stale')||eventJobs[0],report=data?.reports.find(r=>r.id===job?.reportId);
  const friendlyName=(a:string)=>accountLabel(data,a).startsWith('0x')?'一个收款账户':accountLabel(data,a);
  const summary=event?plainReport(event,report,job,friendlyName(event.from),friendlyName(event.to)):undefined;
  const selectEvent=(id:string)=>{setSelected(id);setChosenJob('');setAnalysisError('');setAnalysisMessage('');};
  async function askAgent(eventId:string,text:string){
    const scopedQuestion=text+'\n请用普通用户能听懂的话直接回答这个问题，先说已知事实、再说可能解释和证据缺口。调查锚点是指定账单；24小时量化范围截至该账单，不是全部历史或实时经营状态。不要把资金异常等同于跑路。';
    const j=await api<FlowJob>('/investigations',{eventId,question:scopedQuestion});
    if(j.question!==scopedQuestion)throw new Error('这笔记录已有调查进行中，请等它结束后再提问。');
    setSelected(eventId);setChosenJob(j.id);await refresh();return j;
  }
  async function copy(a:string){try{await navigator.clipboard.writeText(a);if(view==='analysis')setAnalysisMessage('地址已复制。');else setTransferMessage('地址已复制。');}catch{if(view==='analysis')setAnalysisError('无法自动复制，请选择完整地址复制。');else setTransferError('无法自动复制，请选择完整地址复制。');}}
  async function retryAnalysis(){
    if(!event||retryLock.current)return;retryLock.current=true;setRetryPending(true);setAnalysisError('');setAnalysisMessage('');
    try{const j=await api<FlowJob>('/investigations',{eventId:event.id,question:'重新检查这笔账单的资金变动，核查用途与证据缺口。不要给出跑路概率或无依据的跑路断言。'});setChosenJob(j.id);await refresh();setAnalysisMessage('已重新开始检查，结果会自动更新。');}catch(e){setAnalysisError((e as Error).message);}finally{retryLock.current=false;setRetryPending(false);}
  }
  const address=(a:string)=><span className="address" title={a}>{accountLabel(data,a)} <span>{shortAddress(a)}</span> <button className="link" onClick={()=>void copy(a)}>复制</button>{d?.chainId===11155111&&<a href={'https://sepolia.etherscan.io/address/'+a} target="_blank" rel="noreferrer">查看地址</a>}</span>;
  const form=<div className="payment-form">
    {transferError&&<p className="warning" role="alert">{transferError}</p>}{transferMessage&&<p className="message" role="status">{transferMessage}</p>}
    {!merchant&&<div className="recipient"><span>收款方</span><strong>健身房</strong>{d&&<span>{shortAddress(d.accounts.merchant)}</span>}</div>}
    <label htmlFor="payment-amount">{merchant?'转出金额':'付款金额'}</label><div className="amount-field"><input id="payment-amount" placeholder="输入金额" inputMode="numeric" autoComplete="off" value={amount} disabled={transferPending} onChange={e=>{setAmount(e.target.value);setConfirm(false);setTransferError('');}}/><span>GYM</span></div>
    {tooMuch&&<p className="field-error">余额不足，请输入不超过 {balance} GYM 的金额。</p>}{amount&&!amountValid&&<p className="field-error">请输入正整数金额。</p>}
    {merchant&&<><label htmlFor="recipient-address">接收账户</label><input id="recipient-address" placeholder="粘贴 0x 开头的账户地址" value={to} disabled={transferPending} onChange={e=>{setTo(e.target.value);setConfirm(false);setTransferError('');}}/>{to&&!addressValid&&<p className="field-error">请填写有效地址，不能转给自己或零地址。</p>}<button className="link address-preset" disabled={transferPending||!d} onClick={()=>{setTo(d!.accounts.payout);setConfirm(false);}}>使用演示经营账户</button></>}
    {confirm?<div className="confirm"><strong>请确认{merchant?'转出':'付款'}</strong><p>{amount} GYM → {shortAddress(destination)}</p><div><button className="primary" disabled={transferPending||!canTransfer} onClick={()=>void submit()}>{transferPending?'等待确认…':'确认提交'}</button><button className="secondary" disabled={transferPending} onClick={()=>setConfirm(false)}>取消</button></div></div>:<button className="primary full-width" disabled={transferPending||!canTransfer} onClick={()=>setConfirm(true)}>{merchant?'转出资金':'付款'}</button>}
    {!unavailable&&!data?.signingEnabled&&<p className="subtle">当前网络仅支持查询，尚未启用钱包付款。</p>}
    {d&&<details className="account-info"><summary>我的账户信息</summary><p>{d.accounts[role]}</p><button className="link" onClick={()=>void copy(d.accounts[role])}>复制账户地址</button></details>}
  </div>;
  function stage(s:FlowStage){return <section className="agent" key={s.name}><div className="agent-title"><strong>{s.name==='investigator'?'调查 Agent':'独立复核 Agent'}</strong><span>{s.status==='running'?'工作中':s.status==='complete'?'已完成':'未完成'}</span></div><p className="subtle">{s.model} · 实际工具调用 {s.toolRuns.length} 次</p><div className="tool-list">{s.toolRuns.map(t=><span key={t.id}>{t.status==='ok'?'✓':'!'} {toolLabel[t.name]||t.name}</span>)}</div>{s.result?<details><summary>判断、正常解释与证据引用</summary><p>{s.result.summary}</p>{s.result.observations.map((o,i)=><p key={i}>{o.type==='unknown'?'待确认：':'推断：'}{o.text}<small>证据：{o.evidenceIds.join('、')||'无，明确标为未知'}</small></p>)}<p>其他解释：{s.result.alternatives.join('；')}</p><p>建议：{s.result.recommendation}</p><p>局限：{s.result.limitations.join('；')}</p></details>:s.error?<p className="warning">{s.error}</p>:<p className="subtle">正在取证，尚未生成结论。</p>}<details><summary>工具调用与原始返回</summary><pre>{JSON.stringify(s.toolRuns,null,2)}</pre></details></section>;}
  function exportReport(){if(!report)return;const u=URL.createObjectURL(new Blob([JSON.stringify({event,report},null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=u;a.download='今天链不练-'+report.id+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(u),1000);}
  const tabs:{key:FlowView;name:string;description:string;icon:string}[]=[{key:'consumer',name:'会员',description:'付款 · 我的账单',icon:'01'},{key:'merchant',name:'商家',description:'收款 · 资金转出',icon:'02'},{key:'analysis',name:'智能体与分析',description:'调查 · 指标 · 证据',icon:'03'}];
  return <div className="app-shell"><aside className="sidebar"><div className="brand"><img className="brand-icon" src="/gym-chain-icon.png" alt="" width="40" height="40"/><strong>今天链不练</strong></div><nav aria-label="主要功能">{tabs.map(t=><button key={t.key} className={'nav-item '+(view===t.key?'active':'')} aria-current={view===t.key?'page':undefined} disabled={transferPending} onClick={()=>navigate(t.key)}><span>{t.icon}</span><div><strong>{t.name}</strong><small>{t.description}</small></div></button>)}</nav><div className="sidebar-foot">让付款简单，<br/>让资金去向可核查。</div></aside>
    <div className="main-shell"><header className="topbar"><span>{tabs.find(t=>t.key===view)?.name}</span><div className="identity"><span className="demo-tag">{d?.chainId===11155111?'Sepolia 测试网':'本地演示'}</span><label>演示身份 <select value={role} disabled={transferPending} onChange={e=>switchRole(e.target.value as PaymentRole)}><option value="userA">会员 A</option><option value="userB">会员 B</option><option value="merchant">健身房商家</option></select></label></div></header>
    <main key={view}>{(connectionError||data?.error)&&<div className="warning" role="alert">{connectionError||data?.error}</div>}
      {view==='consumer'&&<ConsumerScreen data={data} role={role==='merchant'?lastMember.current:role} form={form} onAnalyze={id=>navigate('analysis',id)}/>}
      {view==='merchant'&&<MerchantScreen data={data} form={form} onAnalyze={id=>navigate('analysis',id)}/>}
      {view==='analysis'&&<div data-testid="analysis-screen"><AgentConversation data={data} event={event} onAsk={askAgent} unavailable={unavailable}/>
        {analysisError&&<div className="warning" role="alert">{analysisError}</div>}{analysisMessage&&<div className="message" role="status">{analysisMessage}</div>}
        <details className="analysis-archive"><summary><span>自动监控与历史账单</span><small>{events.length} 笔已显示 · 展开查看</small></summary><p className="subtle">自动核查仍在后台运行。点击账单可切换下一次提问的锚点，已有回答仍绑定原来的记录。</p><div className="analysis-grid"><section className="card analysis-ledger"><h2>选择要查看的账单</h2><p className="subtle">付款、收款、转出和后续转账。</p>{!events.length?<div className="empty">暂无账单。先在会员栏完成一笔付款。</div>:<div className="analysis-events">{[...events].reverse().map(e=>{const j=data?.jobs.find(j=>j.eventId===e.id&&j.status!=='stale');const note=j?.status==='complete'?'检查完成':j?.status==='partial'?'检查未完成':j?.status==='stale'?'结果已过期':j?'正在检查':'等待检查';return <button className={'event '+(event?.id===e.id?'selected':'')} key={e.id} onClick={()=>selectEvent(e.id)}><span>{friendlyName(e.from)} → {friendlyName(e.to)}<small>{new Date(e.timestamp*1000).toLocaleString('zh-CN')}</small><small>{note}</small></span><b>{e.amount}<small>GYM</small></b></button>;})}</div>}</section>
          <section className="card investigation"><div className="section-title"><h2>这笔账单的检查结果</h2></div>{!summary?<div className="empty">选中一笔账单后，在这里看结果。</div>:<PlainReportCard summary={summary}/>} {job?.status==='partial'&&<p className="subtle">{job.error?.includes('校验')?'记录已查到，但 AI 回答没有通过可信度检查，需要重查。':job.error?.includes('时间')?'这次检查超时了，可以重试。':'这次调查中途失败了，可以重新检查。'}</p>}{event&&<button className="primary" disabled={retryPending||unavailable||!data?.modelConfigured||eventJobs.some(j=>['queued','investigating','reviewing'].includes(j.status))} onClick={()=>void retryAnalysis()}>{retryPending?'正在提交…':eventJobs.some(j=>['queued','investigating','reviewing'].includes(j.status))?'正在检查…':job?.status==='partial'||job?.status==='stale'?'重新检查':'再检查一次'}</button>}</section></div></details>
        <details className="analysis-archive"><summary><span>研究案例与详细证据</span><small>量化指标 · Agent 记录 · 导出报告</small></summary><ResearchPanel/>
        <section className="card technical-workbench" data-testid="technical-analysis"><div className="section-title"><div><span className="eyebrow">详细依据 · 面向研究与核查</span><h2>资金流与智能体分析</h2></div>{report&&<button className="link" onClick={exportReport}>导出完整证据报告</button>}</div><p className="subtle">下方是分析方法、资金线索、智能体执行记录和原始证据。它们与上方的简明结果对应，不是另一套结论。</p><div className="analysis-status"><span>{data?.ready?'● 链上连接有效':'○ 链上未就绪'}</span><span>{data?.modelConfigured?'DeepSeek 已配置':'模型未配置'}</span><span>{data?.automaticAnalysis?'自动调查开启':'自动调查关闭'}</span><span>{events.length} 笔已显示流水 · {data?.jobs.filter(j=>['queued','investigating','reviewing'].includes(j.status)).length||0} 项处理中</span></div>
          {event?<><div className="event-context">{address(event.from)} → {address(event.to)}<strong>{event.amount} GYM</strong></div><p className="subtle">{job?jobStatus[job.status]:'等待调查'} · 截止区块 {job?.asOfBlock??event.blockNumber}</p>{eventJobs.length>1&&<label className="report-version">调查记录 <select value={job?.id||''} onChange={e=>setChosenJob(e.target.value)}>{eventJobs.map(j=><option value={j.id} key={j.id}>{new Date(j.createdAt).toLocaleString('zh-CN')} · {jobStatus[j.status]}</option>)}</select></label>}
          {report&&<><details><summary>原始调查结论</summary><p>{report.headline}</p></details><div className="technical-columns"><section className="technical-section"><h3>资金流规模与量化信号</h3><p className="subtle">关注单笔金额和累计资金流的区别。转出占比较高不是“大额转账”或资金被挪用的证明。</p><div className="quant-grid"><div><strong>{report.metrics.receipts}</strong><small>本次记录前 24 小时收款 / GYM</small></div><div><strong>{report.metrics.outflows}</strong><small>本次记录前 24 小时转出 / GYM</small></div><div><strong>{percentBps(report.metrics.outflowToReceiptBps)}</strong><small>转出 / 收款比例</small></div><div><strong>{report.metrics.baselineCount}</strong><small>历史同类样本数</small></div></div><p>{report.metrics.flags.length?report.metrics.flags.join('；'):'量化规则未命中明显异常，不能据此认定商家安全。'}</p><p className="subtle">同类金额中位数：{report.metrics.baselineMedian??'无可用样本'} GYM · 金额倍数：{report.metrics.amountVsMedianBps===null?'样本不足或无法计算':percentBps(report.metrics.amountVsMedianBps)+'（相对中位数）'}。</p></section><section className="technical-section"><h3>有效线索与信息噪声</h3><p>有效线索是已核验的转账、累计转出比例、接收账户集中度及其时间关系。信号需要与经营用途共同核实。</p><p>不能把一笔小额转账、高转出比例或多笔转入同一地址，单独等同于商家违规；正常经营支出也可能出现这些行为。</p><h3>跨协议活动</h3><p>当前只追踪 GYM 的资金变动及直接接收地址，尚未接入其他协议与其他资产。未查询，不代表没有跨协议活动，也不能把未知收款地址当作已确认的交易所或协议。</p></section></div></>}
          <div className="agent-grid">{job?.stages.length?job.stages.map(stage):<p className="subtle">{job?'任务已排队，尚未调用取证工具。':'尚未启动调查。'}</p>}</div><details><summary>链上原始记录与分析边界</summary><pre>{JSON.stringify(event,null,2)}</pre>{report?.limitations.map((l,i)=><p key={i}>{l}</p>)}<p>本地 EVM 不是公共以太坊；Sepolia 公开链验收尚未完成。Agent 不签名、不冻结资金。两位 Agent 使用同一模型服务，独立取证不等于独立模型。</p></details></>:<div className="empty">选中账单后，详细分析会显示在这里。</div>}
        </section></details></div>}
    </main><footer>测试演示 · GYM 无现金价值 · 身份切换不是正式登录</footer></div></div>;
}
const appRoot=import.meta.hot?.data.appRoot??createRoot(document.getElementById('root')!);
if(import.meta.hot)import.meta.hot.data.appRoot=appRoot;
appRoot.render(<App/>);
