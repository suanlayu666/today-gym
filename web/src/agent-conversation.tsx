import {useState} from 'react';
import type {FlowEvent,FlowJob,FlowOverview} from '../../shared/flow';
import {accountLabel} from './flow-screens';
import {conversationalReport} from '../../shared/plain-report';
import {AnimatedCompanion} from './animated-companion';

const examples=['最近 24 小时的收款和转出，有哪些值得核实的变化？','这笔钱转出去之后，还能追踪到哪里？','这些资金变动，有哪些正常经营的可能解释？'];
const statusText:Record<string,string>={queued:'已排队，等待调查',investigating:'正在读取记录、重算指标',reviewing:'正在独立复核证据',complete:'调查完成',partial:'调查未完整结束',stale:'记录已变化，结果失效'};
type Props={data?:FlowOverview;event?:FlowEvent;onAsk:(eventId:string,question:string)=>Promise<FlowJob>;unavailable:boolean};
export function AgentConversation({data,event,onAsk,unavailable}:Props){
  const [question,setQuestion]=useState(''),[sending,setSending]=useState(false),[error,setError]=useState('');
  const [request,setRequest]=useState<{id:string;eventId:string;question:string}>();
  const requestedJob=data?.jobs.find(j=>j.id===request?.id),requestedEvent=data?.events.find(e=>e.id===request?.eventId);
  const response=data?.reports.find(r=>r.id===requestedJob?.reportId);
  const waiting=!!request&&(!requestedJob||['queued','investigating','reviewing'].includes(requestedJob.status));
  const eventBusy=data?.jobs.some(j=>j.eventId===event?.id&&['queued','investigating','reviewing'].includes(j.status));
  const active=sending||waiting;
  const scopeEvent=active?requestedEvent??event:event;
  const scope=scopeEvent?`${accountLabel(data,scopeEvent.from)} → ${accountLabel(data,scopeEvent.to)} · ${scopeEvent.amount} GYM`:undefined;
  async function ask(){
    if(sending||waiting||eventBusy||!event||!question.trim())return;
    const text=question.trim();setSending(true);setError('');
    try{const job=await onAsk(event.id,text);setRequest({id:job.id,eventId:event.id,question:text});}
    catch(e){setError((e as Error).message);}finally{setSending(false);}
  }
  const finished=response?.status==='complete'&&requestedJob?.status==='complete';
  const result=finished?requestedJob?.stages.find(s=>s.name==='reviewer')?.result:undefined;
  const simple=response&&request?conversationalReport(response,request.question):undefined;
  return <section className={'conversation-hero '+(active?'is-working':'')} data-testid="agent-conversation">
    <AnimatedCompanion/>
    <span className="eyebrow">你的健身调查搭子</span><h1>关于这笔钱，你想知道什么？</h1>
    <p className="conversation-intro">你来提问，我来查记录、找线索，再和你说清楚。</p>
    <div className="conversation-box">
      <form onSubmit={e=>{e.preventDefault();void ask();}}>
        <label className="sr-only" htmlFor="agent-question">向智能体提问</label>
        <textarea id="agent-question" placeholder="比如：最近的转出比例为什么这么高？" value={question} maxLength={900} disabled={active} onChange={e=>setQuestion(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){e.preventDefault();void ask();}}}/>
        <div className="composer-foot"><span>Ctrl / ⌘ + Enter 发送</span><button className="primary" disabled={active||!!eventBusy||unavailable||!data?.modelConfigured||!event||!question.trim()}>{sending?'正在提交…':waiting?'正在调查…':'开始分析 ↗'}</button></div>
      </form>
      <div className="question-examples" aria-label="示例问题">{examples.map(q=><button type="button" key={q} disabled={active} onClick={()=>{setQuestion(q);setError('');}}>{q}</button>)}</div>
      <p className="question-scope">{scope?<>本次锚点：{scope}。<br/>统计截至该笔记录的前 24 小时；后续追踪不超过本次核查区块。可在下方选择其他账单。</>:'还没有可调查的账单，请先完成一笔付款。'}</p>
      {eventBusy&&!waiting&&<p className="subtle" role="status">这笔记录正在自动核查，完成后可继续提问。</p>}
      {!data?.modelConfigured&&<p className="subtle">模型尚未连接，暂时不能提交调查。</p>}
      {error&&<p className="warning" role="alert">{error}</p>}
    </div>
    {request&&<section className="conversation-answer" aria-live="polite" aria-busy={waiting}>
      <p className="asked-question"><span>你问</span>{request.question}</p>
      <div className="answer-status"><span className={waiting?'working-dot':''} aria-hidden="true"/><strong>{statusText[requestedJob?.status??'queued']}</strong></div>
      {finished&&result?<><h2>{simple?.summary}</h2><p className="answer-text">{simple?.details}</p><p className="answer-recommendation">你可以这样做：{simple?.nextStep}</p></>:<p className="answer-text">{waiting?'我正在查这笔钱的记录，查好后会在这里告诉你。':requestedJob?.status==='stale'?'用于调查的记录已经变化，请重新提问。':'这次没查完，还不能下结论。请稍后重试。'}</p>}
      {requestedJob&&<details><summary>查看这次回答的依据</summary><p className="subtle">锚点：{request.eventId.split(':').slice(1).join(':')} · 截止区块 {requestedJob.asOfBlock}</p>{requestedJob.stages.map(s=><div className="conversation-evidence" key={s.name}><strong>{s.name==='investigator'?'调查 Agent':'独立复核 Agent'} · {s.status==='complete'?'已完成':s.status==='running'?'工作中':'未完成'}</strong><p>实际工具调用 {s.toolRuns.length} 次 · {s.toolRuns.map(t=>t.name).join('、')}</p>{s.result&&<p>{s.result.summary}</p>}{s.result?.limitations.map((l,i)=><p key={i}>{l}</p>)}<details><summary>工具返回与证据引用</summary><pre>{JSON.stringify(s,null,2)}</pre></details></div>)}</details>}
      <p className="conversation-boundary">这里只检查资金记录，不能判断健身房会不会关门，也不会冻结资金。</p>
    </section>}
    <p className="monitor-hint">{data?.automaticAnalysis?'后台自动核查保持开启':'后台自动核查未开启'} · 历史账单与报告在下方</p>
  </section>;
}
