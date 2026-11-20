import React, { useEffect, useRef, useState } from "react";
import type { Member, MutationResult, Run, TeamflowCommand, TeamflowSnapshot, WorkflowVersion } from "../../../packages/protocol/src/index";
import type { TeamflowConnection } from "./connection";
import "./desk.css";
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
function stageName(n:string) {
  const names:Record<string,string>={proposal:"商量方案",clarify:"确认需求",fix:"修复",review:"检查结果",test:"测试",accept:"由你验收",deliver:"交付",formal:"正式开发",demo:"制作演示",done:"结束",observe:"核对", "proposal-confirm":"确认方案","demo-confirm":"确认演示"};
  return names[n]??n;
}
function PlainHistory({id,connection,active,who="成员",sent=[]}:{id:string;connection?:TeamflowConnection;active:boolean;who?:string;sent?:TeamflowSnapshot["messages"]}) {
  const [items,set]=useState<{text:string;id:string;at:string}[]>([]),[err,error]=useState("");
  useEffect(()=>{let live=true,reading=false;set([]);error("");if(!active||!connection)return;
    async function load(){if(reading)return;reading=true;try{const raw=await connection!.sessionMessages(id);if(!live)return;
      set(raw.flatMap((x:any)=>{if((x?.role??x?.info?.role??x?.type)!=="assistant")return [];const text=(x.parts??x.content??[]).filter((p:any)=>p.type==="text"&&!p.synthetic&&!p.ignored&&typeof p.text==="string").map((p:any)=>p.text).join("\n")||x.text||(x.error?`这一轮没能回复：${x.error.message??"模型请求失败"}`:"");const ts=x.time?.created??x.time?.start;return typeof text==="string"&&text.trim()?[{id:x.id??x.info?.id,text,at:typeof ts==="number"?new Date(ts).toISOString():""}]:[]}));error("");
    }catch(e){if(live)error(String(e))}finally{reading=false}}
    void load();const timer=setInterval(load,2800);return()=>{live=false;clearInterval(timer)};
  },[id,connection,active]);
  const history=[...sent.map(m=>({id:m.id,text:m.text,at:m.createdAt,mine:true})),...items.map(i=>({...i,mine:false}))].sort((a,b)=>a.at.localeCompare(b.at));
  return <>{err&&<p role="alert">无法读取这位成员原来的会话。<small>{err}</small></p>}{history.map((i,k)=><Post key={i.id??k} who={i.mine?"我":who} mine={i.mine} at={i.at}><ChatText text={i.text}/></Post>)}</>;
}
function currentGate(s:TeamflowSnapshot,r:Run,v?:WorkflowVersion) {
  return s.attempts.filter(a=>a.runId===r.id&&a.status==="awaiting_gate"&&!a.supersededBy).flatMap(a=>{
    const n=v?.graph.nodes.find(x=>x.id===a.nodeId);if(!n?.gate?.user)return [];
    const src=s.attempts.filter(x=>x.runId===r.id&&x.nodeId===n.sourceNodeId&&!x.supersededBy).sort((x,y)=>y.round-x.round)[0];
    const d=s.deliveries.findLast(x=>x.attemptId===src?.id&&!x.staleBy);return d?[{a,d,n}]:[];
  });
}
export function TeamDesk(p:Props) {
  const {s,run,busy,choose,mutate}=p;
  const [drafts,setDrafts]=useState<Record<string,string>>({}),[member,setMember]=useState(""),[tab,setTab]=useState<"chat"|"team"|"progress">("chat");
  const [reply,setReply]=useState(""),[showAll,setAll]=useState(false),[explicitGate,setGate]=useState(""),[topicMode,setTopicMode]=useState(false),[participants,setParticipants]=useState<string[]>([]);
  const end=useRef<HTMLDivElement>(null),follow=useRef(true);
  useEffect(()=>{setMember("");setTab("chat");setReply("");setGate("");setTopicMode(false);setParticipants([]);follow.current=true},[run?.id]);
  const version=run?s.versions.find(v=>v.id===run.versionId):undefined;
  const conversation=s.versions.findLast(v=>v.templateId==="team-conversation");
  const members=s.members.filter(m=>m.runId===run?.id);
  const mname=(id:string)=>niceRole(members.find(m=>m.id===id)?.role);
  const questions=(s.questions??[]).filter(q=>q.runId===run?.id);
  const open=questions.filter(q=>q.status==="open");
  const selectedQ=open.find(q=>q.id===reply)??open[0];
  const gates=run?currentGate(s,run,version):[];
  const privateMember=members.find(m=>m.id===member);
  const needReply=!privateMember&&selectedQ;
  const slot=run?`${run.id}:${privateMember?.id??(selectedQ?.id||"team")}`:"new";
  const draft=drafts[slot]??"";
  const update=(key:string,value:string)=>setDrafts(old=>({...old,[key]:value}));
  const membersNow=members.filter(m=>{const t=s.tasks.find(t=>t.id===m.taskId);const a=s.attempts.find(a=>a.id===t?.attemptId);return t&&a&&!t.child?.staleBy&&["running","submitted"].includes(t.status)&&["running","passed"].includes(a.status)&&!a.supersededBy});
  const primary=membersNow.findLast(m=>m.role==="coordinator")??membersNow.findLast(m=>s.tasks.some(t=>t.id===m.taskId&&t.status==="running"))??membersNow.at(-1);
  const chatTo=privateMember??primary;
  const terminal=!!run&&["cancelled","completed","failed"].includes(run.status);
  const canSend=!busy&&!!draft.trim()&&(run?!terminal&&(!!needReply||!!chatTo&&membersNow.some(m=>m.id===chatTo.id)):!!conversation);
  async function send(){
    if(!canSend)return;const text=draft.trim();
    let result;
    if(!run&&conversation){const runId=`team-${crypto.randomUUID()}`;result=await mutate({type:"run.start",payload:{runId,versionId:conversation.id,label:trimmed(text.split("\n")[0],42),brief:text}});if(result&&!result.inProgress)choose(runId);}
    else if(needReply){result=await mutate({type:"question.answer",payload:{questionId:needReply.id,answer:text}});}
    else if(run&&chatTo){result=await mutate({type:"message.send",payload:{runId:run.id,toMemberId:chatTo.id,text}});if(result&&!result.inProgress)setMember(chatTo.id);}
    if(result&&!result.inProgress)setDrafts(old=>old[slot]===draft?{...old,[slot]:""}:old);
  }
  const timeline:{at:string;k:string;node:React.ReactNode}[]=[];
  const event=(at:string,k:string,node:React.ReactNode)=>timeline.push({at,k,node});
  if(run&&!privateMember){
    event(run.createdAt,"brief",<Post who="我" mine at={run.createdAt}><p>{run.brief}</p></Post>);
    questions.forEach(q=>{
      event(q.createdAt,q.id,<Post who={mname(q.memberId)} at={q.createdAt}><p>{q.question}</p>{q.status==="open"&&<button className="reply-link" onClick={()=>{setReply(q.id);document.querySelector<HTMLTextAreaElement>('.teamdesk:not([hidden]) .compose textarea')?.focus()}}>回复这个问题</button>}{q.status==="superseded"&&<small>这轮工作已被替换</small>}</Post>);
      if(q.answer)event(q.answeredAt??q.createdAt,q.id+"reply",<Post who="我" mine at={q.answeredAt}><small>回复{mname(q.memberId)}</small><p>{q.answer}</p></Post>);
    });
    for(const d of s.deliveries.filter(d=>d.runId===run.id))event(d.createdAt,d.id,<Post who={mname(d.memberId)} at={d.createdAt}><small>{d.staleBy?"上一轮交付":"提交给团队"}</small><ChatText text={d.summary}/>{d.artifacts.length>0&&<details><summary>查看交付依据</summary>{d.artifacts.map(x=><p key={x}>{x}</p>)}</details>}</Post>);
    for(const a of s.approvals.filter(a=>a.runId===run.id))event(a.createdAt,a.id,<Post who={a.kind==="user"?"我":niceRole(a.role)} mine={a.kind==="user"} at={a.createdAt}><p>{a.verdict==="pass"?"同意了这一轮交付。":`要求修改：${a.issues.join("；")||"请按意见调整"}`}</p></Post>);
    for(const msg of s.messages.filter(x=>x.runId===run.id&&x.senderKind==="agent"&&!x.topicId&&!x.patchId&&!x.correctionId&&x.to!=="user"))event(msg.createdAt,msg.id,<Post who={mname(msg.from)} at={msg.createdAt}><small>给{mname(msg.to)}</small><p>{msg.text}</p></Post>);
  }
  timeline.sort((a,b)=>a.at.localeCompare(b.at));
  useEffect(()=>{if(run&&tab==="chat"&&follow.current&&p.active)end.current?.scrollIntoView({block:"nearest"})},[run?.id,timeline.length,tab,member,p.active]);
  const sum=(r:Run)=>{const count=s.questions?.filter(q=>q.runId===r.id&&q.status==="open").length;if(count)return `${count} 个问题等你回答`;if(currentGate(s,r,s.versions.find(v=>v.id===r.versionId)).length)return "等你决定";return statusNames[r.status]??r.status};
  const teamTopics=s.topics.filter(t=>t.runId===run?.id);
  const stoppedTask=s.tasks.findLast(t=>t.runId===run?.id&&t.error&&!t.slotHeld&&t.status==="running"&&!s.attempts.find(a=>a.id===t.attemptId)?.supersededBy);
  const [topicText,setTopicText]=useState("");
  useEffect(()=>setTopicText(""),[run?.id]);
  return <div className="teamdesk">
    <nav className="desk-nav" aria-label="工作台"><div className="desk-brand"><i>t</i> Teamflow</div><button className={!run?"desk-nav-new chosen":"desk-nav-new"} onClick={()=>choose("")}>＋　新讨论</button>
      <h2>最近的团队</h2>{!s.runs.length&&<p className="rail-empty">开始讨论后，团队会留在这里。</p>}
      {[...s.runs].reverse().slice(0,showAll?undefined:8).map(r=><button key={r.id} className={r.id===run?.id?"team-row chosen":"team-row"} onClick={()=>choose(r.id)}><b>{trimmed(r.label,27)}</b><small>{sum(r)}</small></button>)}
      {s.runs.length>8&&<button onClick={()=>setAll(!showAll)}>{showAll?"收起":"更多团队"}</button>}
      <div className="rail-bottom"><button onClick={()=>p.design(conversation?.id)}>◇　设计工作流程</button></div>
    </nav>
    <main className={`desk-main ${run?"has-team":"start"}`}>
      {!run?<div className="welcome"><span className="desk-kicker">团队工作台</span><h1>想和团队一起做什么？</h1><p>先把想法告诉负责人。你们会一起弄清需求，商量好再动手。</p>
        <form className="start-box" onSubmit={e=>{e.preventDefault();void send()}}><label className="sr" htmlFor="first-idea">你的想法</label><textarea id="first-idea" placeholder="例如：我想做个小工具，提醒我哪些事情还没跟进。" value={draft} onChange={e=>update(slot,e.target.value)} maxLength={16000}/><div><small>先讨论，不会直接开始开发</small><button className="desk-primary" disabled={!canSend}>和负责人聊聊 →</button></div></form>
        {!conversation&&<p role="status">这个项目还没有对话流程，请检查项目插件是否已更新。</p>}
        <div className="welcome-steps"><span>01　说想法</span><i>―</i><span>02　一起定方案</span><i>―</i><span>03　看演示、给反馈</span></div></div> :
        <><div className="desk-title"><div><span className="desk-kicker">团队讨论</span><h1>{trimmed(run.label,58)}</h1></div><span className="desk-status">{sum(run)}</span></div>
        <div className="desk-tabs">{([["chat","对话"],["team","成员与议题"],["progress","工作进度"]] as const).map(([k,n])=><button aria-pressed={tab===k} key={k} onClick={()=>setTab(k)}>{n}</button>)}</div>
        {tab==="chat"?<><div className="thread" onScroll={e=>{const t=e.currentTarget;follow.current=t.scrollHeight-t.scrollTop-t.clientHeight<100}}>
          {privateMember?<><button className="reply-link" onClick={()=>setMember("")}>← 返回团队对话</button><h2>和{niceRole(privateMember.role)}的私聊</h2>
            <PlainHistory who={niceRole(privateMember.role)} sent={s.messages.filter(m=>m.to===member&&m.senderKind==="user"&&!m.topicId&&!questions.some(q=>q.answerMessageId===m.id))} id={privateMember.sessionId} connection={p.connection} active={p.active}/></>:
            <>{timeline.map(e=><React.Fragment key={e.k}>{e.node}</React.Fragment>)}
            {teamTopics.length>0&&<button className="reply-link" onClick={()=>setTab("team")}>查看团队的 {teamTopics.length} 个议题 →</button>}
            {gates.map(({a,d,n})=>{const binding={attemptId:a.id,deliveryId:d.id,artifactRevision:d.artifactRevision,criteriaRevision:d.criteriaRevision};const isPlan=n.sourceNodeId===version?.graph.entry;return <section className="decision" key={a.id}><small>需要你决定</small><h2>{isPlan?"按这个方案开始做吗？":"这次交付符合你的预期吗？"}</h2><p>{isPlan?"同意后，开发成员才会开始制作。也可以告诉负责人想调整什么。":"认可后才会往下一步走。如果结果不合适，请告诉团队怎样改。"}</p>
              {explicitGate===a.id?<><label>希望团队改哪里？<textarea value={drafts[a.id]??""} onChange={e=>update(a.id,e.target.value)}/></label><button disabled={busy||!drafts[a.id]?.trim()} onClick={()=>void mutate({type:"gate.reject",payload:{...binding,reason:drafts[a.id].trim()}})}>送回修改</button><button onClick={()=>setGate("")}>取消</button></>:<><button className="desk-primary" disabled={busy||terminal} onClick={()=>void mutate({type:"gate.approve",payload:binding})}>{isPlan?"同意方案，开始制作":"认可这次交付"}</button><button disabled={busy||terminal} onClick={()=>setGate(a.id)}>我想改一改</button></>}</section>})}
            {!gates.length&&!open.length&&!terminal&&(stoppedTask?.sessionId?<><PlainHistory who={mname(stoppedTask.memberId)} id={stoppedTask.sessionId} connection={p.connection} active={p.active}/><small>这位成员结束了本轮回复，但还没有提出待答问题或提交工作。可从工作进度查看具体情况。</small></>:<p className="desk-wait">{run.status==="paused"?"团队已暂停。":"团队正在处理。成员有需要你决定的问题时，会直接写在这里。"}</p>)}
            </>}<div ref={end}/></div>
          <form className="compose" onSubmit={e=>{e.preventDefault();void send()}}><label>{needReply?`回复${mname(needReply.memberId)}的问题`:privateMember?`发给${niceRole(privateMember.role)}`:terminal?"本次工作已结束":chatTo?`追问或补充给${niceRole(chatTo.role)}`:"等待负责人加入"}<textarea placeholder={terminal?"可以回看上面的讨论":"写下你的回答、想法或担心的地方…"} value={draft} disabled={terminal} onChange={e=>update(slot,e.target.value)} maxLength={16000}/></label><button className="desk-primary" disabled={!canSend}>{needReply?"发送回答":"发送"}</button></form></>:
          tab==="team"?<div className="desk-detail"><h2>参与这项工作的人</h2>{!members.length&&<p>负责人加入后将出现在这里。</p>}{members.map((m:Member)=><button className="person" key={m.id} onClick={()=>{setMember(m.id);setTab("chat")}}><span className="desk-avatar">{initials(niceRole(m.role))}</span><b>{niceRole(m.role)}</b><small>{membersNow.some(x=>x.id===m.id)?"私聊 →":"查看历史 →"}</small></button>)}
          <h2>正在商量的事</h2>{!teamTopics.length&&<p>还没有议题。需要两位成员交换看法时，可以请他们一起讨论。</p>}
          {teamTopics.map(t=><article className="topic-card" key={t.id}><b>{t.question}</b><small> · {t.status==="resolved"?"已有结论":t.status==="escalated"?"等你决定":`讨论中 · 第 ${t.round} 轮`}</small>{t.responses.map((v,i)=><Post key={i} who={mname(v.memberId)}><p>{v.text}</p></Post>)}{t.conclusion&&<p>结论：{t.conclusion}</p>}{t.status==="escalated"&&<><textarea aria-label="你的决定" value={drafts[t.id]??""} onChange={e=>update(t.id,e.target.value)}/><button disabled={busy||!drafts[t.id]?.trim()} onClick={()=>void mutate({type:"topic.resolve",payload:{topicId:t.id,conclusion:drafts[t.id]}})}>告诉团队我的决定</button></>}</article>)}
          {membersNow.length>=2&&!terminal&&(!topicMode?<button onClick={()=>setTopicMode(true)}>请成员一起讨论</button>:<form onSubmit={async e=>{e.preventDefault();const r=await mutate({type:"topic.open",payload:{runId:run.id,topicId:crypto.randomUUID(),question:topicText,participantIds:participants}});if(r&&!r.inProgress){setTopicMode(false);setTopicText("");setParticipants([])}}}><label>需要讨论什么？<textarea value={topicText} onChange={e=>setTopicText(e.target.value)}/></label>{membersNow.map(m=><label key={m.id}><input type="checkbox" checked={participants.includes(m.id)} onChange={()=>setParticipants(old=>old.includes(m.id)?old.filter(x=>x!==m.id):[...old,m.id])}/>{niceRole(m.role)}</label>)}<button disabled={busy||!topicText.trim()||participants.length<2}>邀请讨论</button></form>)}</div>:
          <div className="desk-detail"><h2>这项工作怎样往前走</h2><ol className="steps">{version?.graph.nodes.map(n=>{const a=s.attempts.findLast(a=>a.runId===run.id&&a.nodeId===n.id);const map:Record<string,string>={passed:"已完成",awaiting_gate:"等你决定",running:"进行中",ready:"准备开始",pending:"还没开始",needs_revision:"修改中",cancelled:"已取消",failed:"遇到问题"};return <li key={n.id}><b>{stageName(n.name)}</b> <small>{map[a?.status??"pending"]??"旧步骤"}</small></li>})}</ol>
            {!terminal&&<button disabled={busy} onClick={()=>void mutate({type:run.status==="paused"?"run.resume":"run.pause",payload:{runId:run.id}})}>{run.status==="paused"?"继续工作":"暂停团队"}</button>} <button onClick={()=>p.inspect(run.id)}>查看流程图和详细记录</button></div>}</>}
    </main></div>;
}
