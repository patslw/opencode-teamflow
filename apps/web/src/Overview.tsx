import React, { useState } from "react";
import type { Run, TeamflowSnapshot, WorkflowVersion } from "../../../packages/protocol/src/index";
import type {NativeForm} from "../../../packages/protocol/src/rpc";

export type Destination = { tab: "chat" | "team" | "progress"; question?: string; anchor?: string };
const terminal = (r: Run) => ["cancelled", "completed", "failed"].includes(r.status);
const runLabels: Record<string, string> = { running: "进行中", waiting: "等待下一步", paused: "已暂停", completed: "已完成", failed: "未完成", cancelled: "已取消" };
export const stageTitle = (id: string) => ({
  proposal:"商量方案",clarify:"确认需求",fix:"修复",review:"检查结果",test:"测试",accept:"由你验收",
  deliver:"交付",formal:"正式开发",demo:"制作演示",done:"结束",observe:"核对", "proposal-confirm":"确认方案","demo-confirm":"确认演示",
} as Record<string,string>)[id] ?? id;

export function userGates(s: TeamflowSnapshot,r: Run,v?: WorkflowVersion) {
  return s.attempts.filter(a=>a.runId===r.id&&a.status==="awaiting_gate"&&!a.supersededBy).flatMap(a=>{
    const n=v?.graph.nodes.find(x=>x.id===a.nodeId);if(!n?.gate?.user)return [];
    const src=s.attempts.filter(x=>x.runId===r.id&&x.nodeId===n.sourceNodeId&&!x.supersededBy).sort((x,y)=>y.round-x.round)[0];
    const d=s.deliveries.findLast(x=>x.attemptId===src?.id&&!x.staleBy);return d?[{a,d,n}]:[];
  });
}

export function Overview({s,open,start,forms,formError}: {s: TeamflowSnapshot;open:(id:string,where:Destination)=>void;start:()=>void;forms:NativeForm[];formError:string}) {
  const [history,setHistory]=useState(false);
  const all=[...s.runs].reverse(), live=all.filter(r=>!terminal(r));
  const waits=live.flatMap(r=>{
    const v=s.versions.find(v=>v.id===r.versionId);
    return [
      ...forms.filter(f=>f.runId===r.id).map(f=>({id:f.formId,kind:"原生提问",text:f.title,action:"填写回答",where:{tab:"chat",anchor:`native-${f.formId}`} as Destination,run:r})),
      ...(s.questions??[]).filter(q=>q.runId===r.id&&q.status==="open").map(q=>({id:q.id,kind:"待回复",text:q.question,action:"回答问题",where:{tab:"chat",question:q.id} as Destination,run:r})),
      ...userGates(s,r,v).filter(({a})=>!s.approvals.some(p=>p.attemptId===a.id&&p.valid&&p.kind==="user"&&p.verdict==="pass")).map(({a,n})=>({id:a.id,kind:"待确认",text:stageTitle(n.name),action:"查看交付",where:{tab:"chat",anchor:`gate-${a.id}`} as Destination,run:r})),
      ...s.topics.filter(t=>t.runId===r.id&&t.status==="escalated").map(t=>({id:t.id,kind:"待裁决",text:t.question,action:"查看各方意见",where:{tab:"team",anchor:`topic-${t.id}`} as Destination,run:r})),
    ];
  });
  return <div className="overview">
    <div className="overview-heading"><div><span className="desk-kicker">当前项目</span><h1>工作总览</h1></div><button className="desk-primary" onClick={start}>＋ 新讨论</button></div>
    <section aria-label="等我处理"><h2>等我处理 <span className="overview-count">{waits.length}</span></h2>
      {waits.length ? waits.map(w=><div className="inbox-row" key={`${w.kind}:${w.id}`}><div><small>{w.kind} · {w.run.label}</small><p>{w.text}</p></div><button onClick={()=>open(w.run.id,w.where)}>{w.action} →</button></div>) :
        <p className="overview-empty">{live.length?"暂时没有要你回答的问题或要你确认的交付。":"这里会汇总成员向你提的问题和需要你确认的交付。"}</p>}
      {formError&&<small role="status">{formError}</small>}
    </section>
    <section aria-label="团队进度"><h2>团队进度 <span className="overview-count">{live.length}</span></h2>
      {all.some(terminal)&&<label className="overview-filter"><input type="checkbox" checked={history} onChange={e=>setHistory(e.target.checked)}/> 包含已结束的团队</label>}
      {!(history?all:live).length&&<p className="overview-empty">还没有进行中的工作。用「新讨论」把第一个想法交给负责人。</p>}
      {(history?all:live).map(r=>{
        const v=s.versions.find(v=>v.id===r.versionId);
        const stages=v?.graph.nodes.map(n=>({n,a:s.attempts.filter(a=>a.runId===r.id&&a.nodeId===n.id).sort((x,y)=>y.round-x.round)[0]}))??[];
        const completed=stages.filter(({a})=>a?.status==="passed"&&!a.supersededBy).length;
        const doing=stages.filter(({a})=>a&&!a.supersededBy&&["ready","running","awaiting_gate"].includes(a.status)).map(({n})=>stageTitle(n.name));
        return <button className="overview-run" key={r.id} onClick={()=>open(r.id,{tab:"progress"})}><div><b>{r.label}</b><span className="desk-status">{runLabels[r.status]??r.status}</span></div>
          <p>{doing.join("、") || (terminal(r)?runLabels[r.status]:r.status==="paused"?"等待恢复":"等待安排下一步")}</p>
          <small>已完成 {completed} / {stages.length} 个阶段 · 查看流程图 →</small></button>;
      })}
    </section>
  </div>;
}
