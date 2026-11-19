import React from "react";
import { patchImpact, type MutationResult, type TeamflowCommand, type TeamflowSnapshot, type WorkflowPatch } from "../../../packages/protocol/src/index";
import { PatchRecovery } from "./PatchRecovery";

const pretty = (v: unknown) => JSON.stringify(v, null, 2);
/** This card resolves ONLY its saved proposal IDs/versions, never the composer
 * selector. Task/approval states stay live; the reviewed impact identity is fixed. */
export function PatchProposal({ patch: p, snapshot: s, pending, mutate }: {
  patch: WorkflowPatch; snapshot: TeamflowSnapshot; pending: boolean;
  mutate(c: TeamflowCommand): Promise<MutationResult | undefined>;
}) {
  const run = s.runs.find(r => r.id === p.runId);
  const base = s.versions.find(v => v.id === p.baseVersionId), next = s.versions.find(v => v.id === p.proposedVersionId);
  const parent = s.patches.find(x => x.id === p.replacesPatchId);
  const ids = p.affectedAttemptIds ?? [];
  const attempts = ids.map(id => ({ id, attempt: s.attempts.find(a => a.id === id && a.runId === p.runId) }));
  const approvals = s.approvals.filter(a => a.runId === p.runId && (ids.includes(a.attemptId) || ids.includes(a.targetAttemptId)));
  const stale: string[] = [];
  if (!base || !next) stale.push("基础或目标不可变版本缺失，不能核对定义");
  if (!p.affectedAttemptIds) stale.push("缺少固定 affectedAttemptIds，须重新提出完整提案");
  if (!p.mappings) stale.push("缺少固定保留/替代映射");
  if (attempts.some(({ attempt }) => !attempt)) stale.push("固定受影响尝试缺失，不能推定其任务/批准安全");
  if (base && p.affectedNodeIds.some(id => base.graph.nodes.some(n => n.id === id) && !attempts.some(({ attempt: a }) => a?.nodeId === id))) stale.push("固定尝试集合未覆盖已有受影响节点");
  if (p.status !== "superseded" && base && next && pretty(patchImpact(base, next, parent?.affectedNodeIds)) !== pretty(p.affectedNodeIds)) stale.push("固定影响集合已不满足当前 source/依赖闭包，须重新提出");
  if (["proposed", "waiting_boundary", "review_required"].includes(p.status)) {
    if (!run || ["completed", "failed", "cancelled"].includes(run.status)) stale.push("实例缺失或已终态，不能应用/复活");
    if (run && run.versionId !== p.baseVersionId) stale.push("实例基础版本已变化，须重新比较提案");
    if (attempts.some(({ attempt: a }) => a && s.attempts.some(b => b.runId === a.runId && b.nodeId === a.nodeId && b.round > a.round))) stale.push("受影响尝试已更换，提案过时");
    if (p.replacesPatchId && (!parent || parent.status !== "review_required" || parent.replacementPatchId !== p.id)) stale.push("恢复关联不是当前唯一替代关系；不能批准旧的恢复提案");
  }
  return <article aria-label={`固定提案 ${p.id}`}>
    <h3>{p.id} · {p.status === "waiting_boundary" ? "已批准，等待相关工作安全边界" : p.status === "review_required" ? "旧批准过时，需用户重新检查" : p.status === "superseded" ? "已由恢复提案替代，旧历史保留" : p.status}</h3>
    <p>{p.reason} · {p.baseVersionId} → {p.proposedVersionId} · 仅实例 {p.runId}</p>
    {p.replacesPatchId && <p>此恢复提案关联旧批准 {p.replacesPatchId}；新的完整范围需要本提案独立批准，旧权限/批准不会恢复。</p>}
    {p.status === "superseded" && <p>历史过时原因：{p.reviewRequired?.reason ?? "见提案审计"}；实际替代提案：{p.replacementPatchId ?? "见审计"}。旧批准时间与未送达通知保留，不是恢复旧审批。</p>}
    {p.status === "review_required" && <PatchRecovery patch={p} snapshot={s} pending={pending} mutate={mutate} />}
    {stale.map(reason => <p key={reason} role="alert">提案信息缺失 / 过时：{reason}</p>)}
    <h4>此提案固定的受影响尝试与当前任务状态</h4>
    {!ids.length && <p>{p.affectedAttemptIds ? "此提案无已有受影响尝试；新增节点在应用后创建新尝试。" : "固定尝试信息缺失（不是没有影响）。"}</p>}
    {attempts.map(({ id, attempt: a }) => <section key={id} aria-label={`提案尝试 ${id}`}>
      <p>{id} · {a ? `${a.nodeId} / round ${a.round} / ${a.status} / criteria ${a.criteriaRevision} / 定义 ${a.versionId ?? p.baseVersionId}${a.supersededBy ? ` / 适用性失效 ${a.supersededBy}` : ""}` : "尝试缺失"}</p>
      {!s.tasks.some(t => t.attemptId === id && t.runId === p.runId) && <p>{a ? "尚无对应派工任务（不表示尝试已完成）" : "无法解析任务影响"}</p>}
      {s.tasks.filter(t => t.attemptId === id && t.runId === p.runId).map(t => <p key={t.id}>
        任务 {t.id} · {t.status} · slotHeld={String(t.slotHeld)} · {t.writes ? "写任务" : "只读"}
        {t.sessionId ? ` · session ${t.sessionId}` : " · 尚无绑定 session"}{t.child ? ` · 子任务完成事实 ${t.child.completedAt ?? "未完成"} / staleBy=${t.child.staleBy ?? "无"}` : ""}{t.error ? ` · ${t.error}` : ""}
      </p>)}
    </section>)}
    <h4>此提案固定尝试关联的批准与失效影响</h4>
    {!approvals.length && <p>{p.affectedAttemptIds ? "当前无关联批准记录；不等于 Gate 已通过。" : "固定尝试缺失，无法判断批准影响。"}</p>}
    {approvals.map(a => <p key={a.id}>
      批准 {a.id} · {a.kind}/{a.verdict} · {a.valid ? "当前有效；应用本提案将失效，须重验/重新批准" : "已失效；历史保留，不能复用"}
      {` · attempt ${a.attemptId} / target ${a.targetAttemptId} / delivery ${a.deliveryId} / artifact ${a.artifactRevision} / criteria ${a.criteriaRevision}`}
    </p>)}
    <h4>此提案固定保留 / 替代 / 删除映射</h4><pre>{pretty(p.mappings ?? "缺失")}</pre>
    <details><summary>提案元数据 / 固定影响 ID</summary><pre>{pretty(p)}</pre></details>
    <details><summary>此提案的固定图和角色对比（不随上方选择变化）</summary>
      <h4>基础版本</h4><pre>{pretty(base ?? "版本缺失")}</pre>
      <h4>目标版本</h4><pre>{pretty(next ?? "版本缺失")}</pre>
    </details>
    <button disabled={pending || p.status !== "proposed" || !!stale.length} onClick={() => {
      if (confirm(`已检查固定提案 ${p.id} 自身的图、提示词、尝试/任务、批准影响和映射？仅批准应用到 ${p.runId}，相关任务将先等待安全边界。`)) void mutate({ type: "patch.apply", payload: { patchId: p.id } });
    }}>用户显式批准 / 安全边界应用</button>
    {s.messages.filter(m => p.notificationIds?.includes(m.id)).map(m => <p role="alert" key={m.id}>{m.id}：{m.status} · {m.error}</p>)}
  </article>;
}
