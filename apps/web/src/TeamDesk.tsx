import React, { useEffect, useRef, useState } from "react";
import type { Member, MutationResult, Run, TeamflowCommand, TeamflowSnapshot, WorkflowVersion } from "../../../packages/protocol/src/index";
import type { TeamflowConnection } from "./connection";
import "./desk.css";
import { Overview, userGates, stageTitle } from "./Overview";
import { StageGraph } from "./StageGraph";
import { useNavigation } from "./navigation";
import { ProposalFollowup } from "./ProposalFollowups";
import { NativeQuestion,useNativeQuestions } from "./NativeQuestions";
import { LiveSession } from "./LiveSession";
import { ModelRouting } from "./ModelRouting";
import { ChatText } from "./ChatText";

type Props = { s: TeamflowSnapshot; run?: Run; busy: boolean; active: boolean; connection?: TeamflowConnection;
  choose(id: string): void; design(versionId?: string): void; inspect(id: string): void;
  mutate(c: TeamflowCommand): Promise<MutationResult | undefined> };
const roleNames: Record<string,string> = { coordinator:"负责人", developer:"开发", expert:"技术检视", tester:"测试", observer:"核对员", reviewer:"核对员", author:"开发", lead:"负责人" };
const niceRole = (role?: string) => role ? roleNames[role.replace(/^teamflow-/, "")] ?? role : "团队";
const statusNames: Record<string,string> = {running:"进行中",waiting:"等待下一步",paused:"已暂停",completed:"已结束",cancelled:"已取消",failed:"未完成"};
const trimmed = (s: string,n=32) => s.length>n ? `${s.slice(0,n)}…` : s;
const time = (s?:string) => s && !Number.isNaN(Date.parse(s)) ? new Date(s).toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit"}) : "";
const initials = (s:string) => s === "我" ? "我" : s.slice(0,1);
function Post({who,at,children,mine=false}: {who:string;at?:string;children:React.ReactNode;mine?:boolean}) {
  return <article className={`desk-post ${mine?"mine":""}`}><span className="desk-avatar" aria-hidden>{initials(who)}</span><div><div className="byline"><b>{who}</b>{at&&<time>{time(at)}</time>}</div>{children}</div></article>;
}
export function TeamDesk(p:Props) {
  const {s,run,busy,choose,mutate}=p;
  const {view,go}=useNavigation();
  const member=view.memberId??"", tab=view.tab??"chat", reply=view.questionId??"";
  const setTab=(t:"chat"|"team"|"progress")=>go({...view,tab:t,memberId:undefined,anchor:undefined});
  const openMember=(id:string)=>go({...view,tab:"chat",memberId:id||undefined,anchor:undefined});
  const overview=view.page==="overview";
  const [drafts,setDrafts]=useState<Record<string,string>>({});
  const [showAll,setAll]=useState(false),[explicitGate,setGate]=useState(""),[topicMode,setTopicMode]=useState(false),[participants,setParticipants]=useState<string[]>([]);
  const end=useRef<HTMLDivElement>(null),follow=useRef(true);
  useEffect(()=>{setGate("");setTopicMode(false);setParticipants([]);follow.current=true},[run?.id]);
  const version=run?s.versions.find(v=>v.id===run.versionId):undefined;
  const conversation=s.versions.findLast(v=>v.templateId==="team-conversation");
  const members=s.members.filter(m=>m.runId===run?.id);
  const mname=(id:string)=>niceRole(members.find(m=>m.id===id)?.role);
  const questions=(s.questions??[]).filter(q=>q.runId===run?.id);
  const open=questions.filter(q=>q.status==="open");
  const selectedQ=open.find(q=>q.id===reply)??open[0];
  const gates=run?userGates(s,run,version):[];
  const privateMember=members.find(m=>m.id===member);
  const native=useNativeQuestions(s.scope,[...new Set(s.tasks.filter(t=>t.slotHeld&&(overview||t.runId===run?.id)).map(t=>t.runId))],p.active&&(overview||tab==="chat"));
  const proposal=gates.find(g=>g.n.sourceNodeId===version?.graph.entry&&version?.templateId!=="first-review");
  const el=useRef<HTMLTextAreaElement>(null);
  useEffect(()=>{if(!view.anchor)return;const elem=document.getElementById(view.anchor);if(elem)elem.scrollIntoView({block:"center"})},[view.anchor,native.forms.length,run?.id]);
  const needReply=!privateMember&&selectedQ;
  const slot=run?`${run.id}:${privateMember?.id??(selectedQ?.id||"team")}`:"new";
  const draft=drafts[slot]??"";
  const update=(key:string,value:string)=>setDrafts(old=>({...old,[key]:value}));
  const membersNow=members.filter(m=>{const t=s.tasks.find(t=>t.id===m.taskId);const a=s.attempts.find(a=>a.id===t?.attemptId);return t&&a&&!t.child?.staleBy&&["running","submitted"].includes(t.status)&&["running","passed"].includes(a.status)&&!a.supersededBy});
  const primary=membersNow.findLast(m=>m.role==="coordinator")??membersNow.findLast(m=>s.tasks.some(t=>t.id===m.taskId&&t.status==="running"))??membersNow.at(-1);
  const chatTo=privateMember??(proposal&&members.find(m=>m.id===proposal.d.memberId))??primary;
  const terminal=!!run&&["cancelled","completed","failed"].includes(run.status);
  const canSend=!busy&&!!draft.trim()&&(run?!terminal&&(!!needReply||!!chatTo&&membersNow.some(m=>m.id===chatTo.id)):!!conversation);
  async function send(){
    if(!canSend)return;const text=draft.trim();
    let result;
    if(!run&&conversation){const runId=`team-${crypto.randomUUID()}`;result=await mutate({type:"run.start",payload:{runId,versionId:conversation.id,label:trimmed(text.split("\n")[0],42),brief:text}});if(result&&!result.inProgress)choose(runId);}
    else if(needReply){result=await mutate({type:"question.answer",payload:{questionId:needReply.id,answer:text}});}
    else if(run&&chatTo){result=await mutate({type:"message.send",payload:{runId:run.id,toMemberId:chatTo.id,text,...(proposal&&!privateMember?{purpose:"proposal_discussion" as const}:{})}});if(result&&!result.inProgress&&(!proposal||privateMember))openMember(chatTo.id);}
    if(result&&!result.inProgress)setDrafts(old=>old[slot]===draft?{...old,[slot]:""}:old);
  }
  const timeline:{at:string;k:string;node:React.ReactNode}[]=[];
  const event=(at:string,k:string,node:React.ReactNode)=>timeline.push({at,k,node});
  if(run&&!privateMember){
    event(run.createdAt,"brief",<Post who="我" mine at={run.createdAt}><p>{run.brief}</p></Post>);
    questions.forEach(q=>{
      event(q.createdAt,q.id,<Post who={mname(q.memberId)} at={q.createdAt}><p>{q.question}</p>{q.status==="open"&&<button className="reply-link" onClick={()=>{go({...view,questionId:q.id,anchor:undefined});el.current?.focus()}}>回复这个问题</button>}{q.status==="superseded"&&<small>这轮工作已被替换</small>}</Post>);
      if(q.answer)event(q.answeredAt??q.createdAt,q.id+"reply",<Post who="我" mine at={q.answeredAt}><small>回复{mname(q.memberId)}</small><p>{q.answer}</p></Post>);
    });
    for(const msg of s.messages.filter(m=>m.runId===run.id&&m.purpose==="proposal_discussion"))event(msg.createdAt,msg.id,<ProposalFollowup msg={msg} sessionId={members.find(m=>m.id===msg.to)?.sessionId} connection={p.connection} active={p.active}/>);
    for(const d of s.deliveries.filter(d=>d.runId===run.id))event(d.createdAt,d.id,<Post who={mname(d.memberId)} at={d.createdAt}><small>{d.staleBy?"上一轮交付":"提交给团队"}</small><ChatText text={d.summary}/>{d.artifacts.length>0&&<details><summary>查看交付依据</summary>{d.artifacts.map(x=><p key={x}>{x}</p>)}</details>}</Post>);
    for(const a of s.approvals.filter(a=>a.runId===run.id))event(a.createdAt,a.id,<Post who={a.kind==="user"?"我":niceRole(a.role)} mine={a.kind==="user"} at={a.createdAt}><p>{a.verdict==="pass"?"同意了这一轮交付。":`${version?.graph.nodes.find(n=>n.id===s.attempts.find(t=>t.id===a.attemptId)?.nodeId)?.sourceNodeId===version?.graph.entry?"调整方案":"要求修改"}：${a.issues.join("；")||"请按意见调整"}`}</p></Post>);
    for(const msg of s.messages.filter(x=>x.runId===run.id&&x.senderKind==="agent"&&!x.topicId&&!x.patchId&&!x.correctionId&&x.to!=="user"))event(msg.createdAt,msg.id,<Post who={mname(msg.from)} at={msg.createdAt}><small>给{mname(msg.to)}</small><p>{msg.text}</p></Post>);
  }
  timeline.sort((a,b)=>a.at.localeCompare(b.at));
  useEffect(()=>{if(run&&tab==="chat"&&follow.current&&p.active)end.current?.scrollIntoView({block:"nearest"})},[run?.id,timeline.length,tab,member,p.active]);
  const sum=(r:Run)=>{const count=s.questions?.filter(q=>q.runId===r.id&&q.status==="open").length;if(count)return `${count} 个问题等你回答`;if(userGates(s,r,s.versions.find(v=>v.id===r.versionId)).length)return "等你决定";return statusNames[r.status]??r.status};
  const teamTopics=s.topics.filter(t=>t.runId===run?.id);
  const stoppedTask=s.tasks.findLast(t=>t.runId===run?.id&&t.error&&!t.slotHeld&&t.status==="running"&&!s.attempts.find(a=>a.id===t.attemptId)?.supersededBy);
  const [topicText,setTopicText]=useState("");
  useEffect(()=>setTopicText(""),[run?.id]);
  return <div className="teamdesk">
    <nav className="desk-nav" aria-label="工作台"><div className="desk-brand"><i>t</i> Teamflow</div><button className={overview?"desk-nav-new chosen":"desk-nav-new"} onClick={()=>go({page:"overview"})}>▦　项目总览</button><button className={view.page==="new"?"desk-nav-new chosen":"desk-nav-new"} onClick={()=>choose("")}>＋　新讨论</button>
      <h2>最近的团队</h2>{!s.runs.length&&<p className="rail-empty">开始讨论后，团队会留在这里。</p>}
      {[...s.runs].reverse().slice(0,showAll?undefined:8).map(r=><button key={r.id} className={r.id===run?.id?"team-row chosen":"team-row"} onClick={()=>choose(r.id)}><b>{trimmed(r.label,27)}</b><small>{sum(r)}</small></button>)}
      {s.runs.length>8&&<button onClick={()=>setAll(!showAll)}>{showAll?"收起":"更多团队"}</button>}
      <div className="rail-bottom"><button onClick={()=>p.design(conversation?.id)}>◇　设计工作流程</button></div>
    </nav>
    <main className={`desk-main ${overview?"dashboard":run?"has-team":"start"}`}>
      {overview?<Overview s={s} start={()=>choose("")} forms={native.forms} formError={native.error} open={(runId,w)=>go({page:"run",runId,tab:w.tab,questionId:w.question,anchor:w.anchor})}/>:!run?<div className="welcome"><span className="desk-kicker">团队工作台</span><h1>想和团队一起做什么？</h1><p>先把想法告诉负责人。你们会一起弄清需求，商量好再动手。</p>
        <form className="start-box" onSubmit={e=>{e.preventDefault();void send()}}><label className="sr" htmlFor="first-idea">你的想法</label><textarea id="first-idea" placeholder="例如：我想做个小工具，提醒我哪些事情还没跟进。" value={draft} onChange={e=>update(slot,e.target.value)} maxLength={16000}/><div><small>先讨论，不会直接开始开发</small><button className="desk-primary" disabled={!canSend}>和负责人聊聊 →</button></div></form>
        {!conversation&&<p role="status">这个项目还没有对话流程，请检查项目插件是否已更新。</p>}
        <div className="welcome-steps"><span>01　说想法</span><i>―</i><span>02　一起定方案</span><i>―</i><span>03　看演示、给反馈</span></div></div> :
        <><div className="desk-title"><div><span className="desk-kicker">团队讨论</span><h1>{trimmed(run.label,58)}</h1></div><span className="desk-status">{sum(run)}</span></div>
        <div className="desk-tabs">{([["chat","对话"],["team","成员与议题"],["progress","工作进度"]] as const).map(([k,n])=><button aria-pressed={tab===k} key={k} onClick={()=>setTab(k)}>{n}</button>)}</div>
        {tab==="chat"?<><div className="thread" onScroll={e=>{const t=e.currentTarget;follow.current=t.scrollHeight-t.scrollTop-t.clientHeight<100}}>
          {privateMember?<><button className="reply-link" onClick={()=>openMember("")}>团队对话</button><h2>和{niceRole(privateMember.role)}的私聊</h2>
            <LiveSession scope={s.scope} who={niceRole(privateMember.role)} sent={s.messages.filter(m=>m.to===member&&m.senderKind==="user"&&!m.purpose&&!m.topicId&&!questions.some(q=>q.answerMessageId===m.id))} sessionId={privateMember.sessionId} active={p.active}/></>:
            <>{timeline.map(e=><React.Fragment key={e.k}>{e.node}</React.Fragment>)}
            {teamTopics.length>0&&<button className="reply-link" onClick={()=>setTab("team")}>查看团队的 {teamTopics.length} 个议题 →</button>}
            {native.forms.filter(f=>f.runId===run.id).map(f=><NativeQuestion key={f.formId} f={f} scope={s.scope} refresh={native.refresh}/>)}{native.error&&<small>{native.error}</small>}
             {gates.map(({a,d,n})=>{const binding={attemptId:a.id,deliveryId:d.id,artifactRevision:d.artifactRevision,criteriaRevision:d.criteriaRevision};const isPlan=n.sourceNodeId===version?.graph.entry;return <section className="decision" key={a.id} id={`gate-${a.id}`}><small>需要你决定</small><h2>{isPlan?"按这个方案开始做吗？":"这次交付符合你的预期吗？"}</h2><p>{isPlan?"还不确定？在下方问负责人，不会退回方案，也不会开工。":"认可后才会往下一步走。如果结果不合适，请告诉团队怎样改。"}</p>
               {isPlan&&<button className="reply-link" onClick={()=>go({...view,tab:"progress",anchor:"run-model-routing"})}>查看或调整派工模型 →</button>}
              {explicitGate===a.id?<><label>希望团队改哪里？<textarea value={drafts[a.id]??""} onChange={e=>update(a.id,e.target.value)}/></label><button disabled={busy||!drafts[a.id]?.trim()} onClick={()=>void mutate({type:"gate.reject",payload:{...binding,reason:drafts[a.id].trim()}})}>{isPlan?"请负责人调整方案":"送回修改"}</button><button onClick={()=>setGate("")}>取消</button></>:<><button className="desk-primary" disabled={busy||terminal} onClick={()=>void mutate({type:"gate.approve",payload:binding})}>{isPlan?"同意方案，开始制作":"认可这次交付"}</button><button disabled={busy||terminal} onClick={()=>setGate(a.id)}>{isPlan?"调整方案内容":"我想改一改"}</button></>}</section>})}
             {!gates.length&&!open.length&&!terminal&&(stoppedTask?.sessionId?<p className="desk-wait">这位成员结束了本轮回复，还没有提出待答问题或提交工作。 <button onClick={()=>openMember(stoppedTask.memberId)}>查看{mname(stoppedTask.memberId)}的会话</button></p>:<p className="desk-wait">{run.status==="paused"?"团队已暂停。":"成员有需要你决定的问题时，会直接写在这里。"} {membersNow.filter(m=>s.tasks.some(t=>t.id===m.taskId&&t.slotHeld)).map(m=><button key={m.id} onClick={()=>openMember(m.id)}>查看{niceRole(m.role)}的实时会话</button>)}</p>)}
            </>}<div ref={end}/></div>
          {needReply&&needReply.options?.length? <div className="answer-options" aria-label="建议回答">{needReply.options.map(o=><button key={o} type="button" aria-pressed={draft===o} onClick={()=>{update(slot,o);el.current?.focus()}}>{o}</button>)}<small>可选一项再补充，也可以直接输入</small></div>:null}
          <form className="compose" onSubmit={e=>{e.preventDefault();void send()}}><label>{needReply?`回复${mname(needReply.memberId)}的问题`:privateMember?`发给${niceRole(privateMember.role)}`:terminal?"本次工作已结束":proposal?"和负责人继续讨论方案":chatTo?`追问或补充给${niceRole(chatTo.role)}`:"等待负责人加入"}<textarea ref={el} placeholder={terminal?"可以回看上面的讨论":"写下你的回答、想法或担心的地方…"} value={draft} disabled={terminal} onChange={e=>update(slot,e.target.value)} maxLength={16000}/></label><button className="desk-primary" disabled={!canSend}>{needReply?"发送回答":"发送"}</button></form></>:
          tab==="team"?<div className="desk-detail"><h2>参与这项工作的人</h2>{!members.length&&<p>负责人加入后将出现在这里。</p>}{members.map((m:Member)=><button className="person" key={m.id} onClick={()=>{openMember(m.id)}}><span className="desk-avatar">{initials(niceRole(m.role))}</span><b>{niceRole(m.role)}</b><small>{membersNow.some(x=>x.id===m.id)?"私聊 →":"查看历史 →"}</small></button>)}
          <h2>正在商量的事</h2>{!teamTopics.length&&<p>还没有议题。需要两位成员交换看法时，可以请他们一起讨论。</p>}
          {teamTopics.map(t=><article className="topic-card" key={t.id} id={`topic-${t.id}`}><b>{t.question}</b><small> · {t.status==="resolved"?"已有结论":t.status==="escalated"?"等你决定":`讨论中 · 第 ${t.round} 轮`}</small>{t.responses.map((v,i)=><Post key={i} who={mname(v.memberId)}><p>{v.text}</p></Post>)}{t.conclusion&&<p>结论：{t.conclusion}</p>}{t.status==="escalated"&&<><textarea aria-label="你的决定" value={drafts[t.id]??""} onChange={e=>update(t.id,e.target.value)}/><button disabled={busy||!drafts[t.id]?.trim()} onClick={()=>void mutate({type:"topic.resolve",payload:{topicId:t.id,conclusion:drafts[t.id]}})}>告诉团队我的决定</button></>}</article>)}
          {membersNow.length>=2&&!terminal&&(!topicMode?<button onClick={()=>setTopicMode(true)}>请成员一起讨论</button>:<form onSubmit={async e=>{e.preventDefault();const r=await mutate({type:"topic.open",payload:{runId:run.id,topicId:crypto.randomUUID(),question:topicText,participantIds:participants}});if(r&&!r.inProgress){setTopicMode(false);setTopicText("");setParticipants([])}}}><label>需要讨论什么？<textarea value={topicText} onChange={e=>setTopicText(e.target.value)}/></label>{membersNow.map(m=><label key={m.id}><input type="checkbox" checked={participants.includes(m.id)} onChange={()=>setParticipants(old=>old.includes(m.id)?old.filter(x=>x!==m.id):[...old,m.id])}/>{niceRole(m.role)}</label>)}<button disabled={busy||!topicText.trim()||participants.length<2}>邀请讨论</button></form>)}</div>:
          <div className="desk-detail"><h2>这项工作怎样往前走</h2>{version&&<StageGraph version={version} run={run} snapshot={s} selectedId={view.nodeId} onSelect={id=>go({...view,nodeId:id})}/>}
            {version&&view.nodeId&&(()=>{const n=version.graph.nodes.find(x=>x.id===view.nodeId);if(!n)return null;const a=s.attempts.findLast(x=>x.runId===run.id&&x.nodeId===n.id);return <section className="stage-summary"><h3>{stageTitle(n.name)}</h3><p>{n.role?`由${niceRole(n.role)}负责。`:n.gate?.user?"这一步需要你决定是否继续。":"流程步骤。"}</p>{!!n.skills?.length&&<p>阶段技能：{n.skills.join("、")}</p>}{n.tools!==undefined&&<p>指定工具：{n.tools.join("、")||"仅协作工具"}</p>}{members.filter(m=>s.tasks.some(t=>t.attemptId===a?.id&&t.memberId===m.id)).map(m=><button key={m.id} onClick={()=>openMember(m.id)}>查看{niceRole(m.role)}的实时会话 →</button>)}</section>})()}
             <div id="run-model-routing"><ModelRouting scope={s.scope} snapshot={s} run={run} mutate={mutate} busy={busy}/></div>
             {!terminal&&<button disabled={busy} onClick={()=>void mutate({type:run.status==="paused"?"run.resume":"run.pause",payload:{runId:run.id}})}>{run.status==="paused"?"继续工作":"暂停团队"}</button>} <button onClick={()=>p.inspect(run.id)}>流程配置与工作记录</button></div>}</>}
    </main></div>;
}
