import React, { useState } from "react";
import type { MutationResult, TeamflowCommand, TeamflowSnapshot } from "../../../packages/protocol/src/index";

export function CollaborationPanel({ snapshot: s, runId, mutate, pending }: {
  snapshot: TeamflowSnapshot; runId: string; pending: boolean;
  mutate(command: TeamflowCommand): Promise<MutationResult | undefined>;
}) {
  const [recipient, setRecipient] = useState(""), [text, setText] = useState("");
  const [question, setQuestion] = useState(""), [participants, setParticipants] = useState<string[]>([]);
  const [reason, setReason] = useState(""), [requirements, setRequirements] = useState("");
  const [affected, setAffected] = useState<string[]>([]), [conclusion, setConclusion] = useState("");
  const [actions, setActions] = useState("");
  const [messageTopic, setMessageTopic] = useState(""), [unrelated, setUnrelated] = useState("");
  const members = s.members.filter(m => m.runId === runId);
  const run = s.runs.find(r => r.id === runId)!;
  const disabled = pending || ["cancelled", "failed", "completed"].includes(run.status);
  const correctionDisabled = pending || ["cancelled", "failed"].includes(run.status);
  const attempts = s.attempts.filter(a => a.runId === runId && !s.attempts.some(b => b.previousAttemptId === a.id));
  const toggle = (values: string[], id: string) => values.includes(id) ? values.filter(v => v !== id) : [...values, id];
  // All operations use the parent's MutationRetry/journal. Never reset input after
  // awaiting a mutation: newer local edits/navigation must survive late receipts.
  return <section aria-label="协作与纠偏">
    <h3>协作与纠偏</h3>
    <p className="muted">独立成员与逻辑子成员。已提交成员在同一 session 继续交流，由调度器重新取得槽位和写租约；不复活已取消/被替换的工作。讨论结论不等于批准。</p>
    <details open><summary>成员与直接消息</summary>
      {members.map(m => <p key={m.id}>{m.role} · {m.id} · {m.sessionId}{m.parentMemberId ? ` · 父成员 ${m.parentMemberId}` : " · 独立成员"}</p>)}
      <label className="field">收件成员<select value={recipient} onChange={e => setRecipient(e.target.value)}>
        <option value="">选择真实成员</option>{members.map(m => <option key={m.id} value={m.id}>{m.role} · {m.id}</option>)}
      </select></label>
      <label className="field">用户消息<textarea value={text} onChange={e => setText(e.target.value)} /></label>
      <label className="field">消息议题<select value={messageTopic} onChange={e => setMessageTopic(e.target.value)}><option value="">不关联议题（有歧义时须说明无关原因）</option>{s.topics.filter(t => t.runId === runId).map(t => <option key={t.id} value={t.id}>{t.id} · {t.status}</option>)}</select></label>
      <label className="field">与议题无关的明确原因<input value={unrelated} onChange={e => setUnrelated(e.target.value)} /></label>
      <button disabled={correctionDisabled || !recipient || !text.trim()} onClick={() => void mutate({ type: "message.send", payload: { runId, toMemberId: recipient, text, ...(messageTopic ? { topicId: messageTopic } : unrelated ? { unrelatedReason: unrelated } : {}) } })}>以用户身份入队 / 同会话继续</button>
      <p>持久化意图 ≠ 原生接收 ≠ 成员处理确认。调度器等待容量后继续同会话；未知投递不重发，可据证核对/终止。</p>
      {s.messages.filter(m => m.runId === runId).map(m => <article key={m.id}>
        <strong>{m.from} → {m.to}</strong><p>{m.text}</p>
        <small>{m.id} · {m.status === "undelivered" ? "明确未送达原成员，已升级给用户（不是原生接收或处理确认）" : m.status === "cancelled" ? "已取消 / 终止，不代表成员处理确认（原生接收事实另列）" : m.status === "intent" ? "持久化意图，尚未投递" : m.status === "acknowledged" ? "成员已确认处理" : m.status === "uncertain" ? "投递不确定：只核对，不重发" : "已获原生接收凭据，未确认处理"}
          {m.admission ? ` · ${m.admission === "accepted" ? "API admission" : m.admission === "observed_inbox" ? "真实 inbox 已观测" : m.admission === "observed_context" ? "真实会话上下文已观测" : m.request?.state === "not_sent" ? "已证未发出" : m.request?.state === "settled" && m.status === "cancelled" ? "原生接收结果未证实；调用已封闭" : "原生调用待定"}` : ""}{m.error ? ` · ${m.error}` : ""}</small>
        <p><button disabled={pending} onClick={() => void mutate({ type: "message.reconcile", payload: { messageId: m.id, action: "inspect", reason: "用户核对协作调用的真实原生依据" } })}>据证核对投递（不重发）</button>
          {m.status === "intent" && !m.continuationAuthorized && !m.request && !m.admission && <button disabled={pending} onClick={() => void mutate({ type: "message.reconcile", payload: { messageId: m.id, action: "adopt", reason: "用户显式授权旧的未发出意图进入受控同会话继续，不是未知投递重试" } })}>显式授权旧意图继续</button>}
           <button disabled={pending || m.status === "acknowledged" || m.status === "undelivered" && !!(m.correctionId || m.patchId)} onClick={() => { if (window.confirm("终止此消息并中断当前会话执行？只有真实原生安全证据才释放租约；未知调用未被证明安全时仍等待。")) void mutate({ type: "message.reconcile", payload: { messageId: m.id, action: "terminate", reason: "用户请求终止协作消息/当前执行，等待真实安全边界" } }); }}>据证终止（可能仍等待）</button></p>
         {m.status === "undelivered" && (m.correctionId || m.patchId) && <p>
          此通知从未发出，不能用消息终止清除升级。请在原任务 {m.taskId} 的“派工与租约”中重新核对，必要时请求安全终止（dispatch.reconcile inspect/terminate）；如有另一个实际未决消息，按它自己的 messageId 恢复。任务安全恢复后，此通知仍为未送达、需用户关注；不会重发或恢复旧工作。
          {m.taskId && <button disabled={pending} onClick={() => void mutate({ type: "dispatch.reconcile", payload: { taskId: m.taskId!, action: "inspect", reason: "核对未送达纠偏通知对应的原任务安全边界，不终止该通知" } })}>核对原任务派发边界</button>}
        </p>}
        {s.tasks.find(t => t.id === m.taskId)?.messageRecovery?.messageId === m.id && <p>{s.tasks.find(t => t.id === m.taskId)?.messageRecovery?.evidence.join("；")}</p>}
        {s.tasks.find(t => t.id === m.taskId)?.messageInspection?.messageId === m.id && <p>{s.tasks.find(t => t.id === m.taskId)?.messageInspection?.evidence.join("；")}</p>}
      </article>)}
    </details>
    <details><summary>议题：先独立意见，最多三轮</summary>
      <label className="field">议题<textarea value={question} onChange={e => setQuestion(e.target.value)} /></label>
      {members.map(m => <label key={m.id}><input type="checkbox" checked={participants.includes(m.id)} onChange={() => setParticipants(toggle(participants, m.id))} />{m.role} · {m.id}</label>)}
      <button disabled={disabled || participants.length < 2 || !question.trim()} onClick={() => void mutate({ type: "topic.open", payload: { runId, topicId: crypto.randomUUID(), question, participantIds: participants, ...(unrelated ? { unrelatedReason: unrelated } : {}) } })}>发起独立意见</button>
      <label className="field">用户总结（不批准）<textarea value={conclusion} onChange={e => setConclusion(e.target.value)} /></label>
      <label className="field">行动项（每行一条）<textarea value={actions} onChange={e => setActions(e.target.value)} /></label>
      {s.topics.filter(t => t.runId === runId).map(t => <article key={t.id}>
        <h4>{t.question} · 第 {t.round} 轮 · {t.status}</h4>
        <p>{t.status === "escalated" ? `升级给用户（不是批准）：${t.escalationReason ?? "讨论预算已用完或参与成员不可继续"}` : "首轮所有成员先独立提交，之后才转发相关意见。"}</p>
        <p>关联任务：{t.relatedTaskIds?.join(", ") ?? "见参与成员任务"}</p>
        {t.responses.map((r, i) => <p key={i}>第 {r.round ?? 1} 轮 · {r.memberId}: {r.text} · 证据：{r.evidence?.join(", ") || "未附引用"}</p>)}
        {t.conclusion && <p>结论（非批准）：{t.conclusion}</p>}
        {t.actionItems?.map((item, i) => <p key={i}>行动：{item}</p>)}
        <button disabled={disabled || t.status === "resolved" || t.round === 1 && t.status !== "escalated" || !conclusion.trim()} onClick={() => void mutate({ type: "topic.resolve", payload: { topicId: t.id, conclusion, actionItems: actions.split("\n").map(x => x.trim()).filter(Boolean) } })}>记录用户结论 / 处理升级（不批准）</button>
      </article>)}
    </details>
    <details><summary>要求纠偏与依赖影响</summary>
      <label className="field">纠偏原因<textarea value={reason} onChange={e => setReason(e.target.value)} /></label>
      <label className="field">新的实际要求<textarea value={requirements} onChange={e => setRequirements(e.target.value)} /></label>
      {attempts.map(a => <label key={a.id}><input type="checkbox" checked={affected.includes(a.id)} onChange={() => setAffected(toggle(affected, a.id))} />{a.nodeId} · {a.criteriaRevision} · {a.status}</label>)}
      <button disabled={correctionDisabled || !reason.trim() || !requirements.trim() || !affected.length} onClick={() => void mutate({ type: "correction.propose", payload: { runId, correctionId: crypto.randomUUID(), reason, requirements, affectedAttemptIds: affected } })}>提出纠偏（含下游影响）</button>
      <p>应用后旧交付/批准失效，受影响任务停止并等待原生安全边界；未受影响任务继续。不会修改模板、降低 Gate 或仅因 interrupt 请求释放 writer。</p>
      {s.corrections.filter(c => c.runId === runId).map(c => <article key={c.id}>
        <h4>{c.id} · {c.status === "waiting_boundary" ? "等待安全执行边界（未释放租约）" : c.status}</h4>
        <p>{c.reason} · 新要求：{c.requirements ?? c.reason}</p>
        <p>依据版本：{c.criteriaRevision} · 影响节点：{c.affectedNodeIds?.join(", ") ?? "应用时计算依赖闭包"}</p>
        <p>影响尝试：{c.affectedAttemptIds.join(", ")} · 通知：{c.notificationIds?.join(", ") || "尚未生成"}</p>
        {(c.notificationIds ?? []).map(id => { const m = s.messages.find(m => m.id === id); return m && <p key={id} role={m.status === "undelivered" ? "alert" : undefined}>
          原成员 {m.to} 通知：{m.status === "undelivered" ? "未送达，用户需处理；不自动恢复旧工作" : m.status === "acknowledged" ? "成员已处理确认" : m.admission && m.admission !== "pending" ? "原生已接收，处理未确认" : "尚无送达证据"}。{m.error}
        </p>; })}
        <p>替代尝试：{(c.replacementAttemptIds ?? s.attempts.filter(a => a.previousAttemptId && c.affectedAttemptIds.includes(a.previousAttemptId)).map(a => a.id)).join(", ") || "尚未登记或等待边界"}</p>
        <button disabled={correctionDisabled || c.status !== "proposed"} onClick={() => { if (window.confirm("应用实际要求变更？受影响交付与批准会过期，安全边界可能需要人工处理。此操作不降低 Gate。")) void mutate({ type: "correction.apply", payload: { correctionId: c.id } }); }}>用户应用纠偏</button>
      </article>)}
    </details>
  </section>;
}
