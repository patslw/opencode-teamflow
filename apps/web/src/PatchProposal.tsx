import React from "react";
import { patchImpact, type MutationResult, type TeamflowCommand, type TeamflowSnapshot, type WorkflowPatch } from "../../../packages/protocol/src/index";
import { DefinitionChanges, PatchRecovery } from "./PatchRecovery";

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
    <h3>应用提案 · {p.status === "proposed" ? "等待确认" : p.status === "waiting_boundary" ? "已批准，等待相关工作安全边界" : p.status === "review_required" ? "旧批准过时，需重新检查" : p.status === "superseded" ? "已由新提案替代" : p.status}</h3>
    <p>变更原因：{p.reason}。仅应用到当前工作。</p>
    {p.replacesPatchId && <p>此提案用于重新检查旧批准；新的完整范围需要独立批准，旧批准不会恢复。</p>}
    {p.status === "superseded" && <p>历史过时原因：{p.reviewRequired?.reason ?? "见提案审计"}。旧批准和未送达通知会保留，不会恢复旧审批。</p>}
    {p.status === "review_required" && <PatchRecovery patch={p} snapshot={s} pending={pending} mutate={mutate} />}
    {stale.map(reason => <p key={reason} role="alert">提案信息缺失 / 过时：{reason}</p>)}
    <p>涉及 {ids.length} 个已有步骤的执行记录，{approvals.filter(a => a.valid).length} 项有效批准将在应用后失效，需要重新确认。</p>
    {base && next && <DefinitionChanges base={base} next={next} />}
    <details><summary>受影响的执行记录与批准证据</summary>
    <h4>此提案固定的受影响尝试与当前任务状态</h4>
    {!ids.length && <p>{p.affectedAttemptIds ? "此提案无已有受影响尝试；新增节点在应用后创建新尝试。" : "固定尝试信息缺失（不是没有影响）。"}</p>}
    {attempts.map(({ id, attempt: a }) => <section key={id} aria-label={`提案尝试 ${id}`}>
      <p>{a ? `${base?.graph.nodes.find(n => n.id === a.nodeId)?.name ?? a.nodeId} · 第 ${a.round} 轮 · ${a.status}${a.supersededBy ? " · 已失效" : ""}` : "执行记录缺失"}</p>
      {!s.tasks.some(t => t.attemptId === id && t.runId === p.runId) && <p>{a ? "尚无对应派工任务（不表示尝试已完成）" : "无法解析任务影响"}</p>}
      {s.tasks.filter(t => t.attemptId === id && t.runId === p.runId).map(t => <p key={t.id}>
        任务状态：{t.status} · {t.slotHeld ? "仍占用执行位置" : "未占用执行位置"} · {t.writes ? "可修改" : "只读"}
        {t.child ? ` · 子任务${t.child.completedAt ? "已完成" : "未完成"}${t.child.staleBy ? "，结果已失效" : ""}` : ""}{t.error ? ` · ${t.error}` : ""}
      </p>)}
    </section>)}
    <h4>此提案固定尝试关联的批准与失效影响</h4>
    {!approvals.length && <p>{p.affectedAttemptIds ? "当前无关联批准记录；不等于 Gate 已通过。" : "固定尝试缺失，无法判断批准影响。"}</p>}
    {approvals.map(a => <p key={a.id}>
      批准记录 {a.id} · {a.kind === "user" ? "用户" : a.kind === "review" ? "审核" : "测试"} · {a.verdict === "pass" ? "通过" : a.verdict === "reject" ? "拒绝" : "需修改"} · {a.valid ? "当前有效；应用后失效，须重新批准" : "已失效，不可复用"} · 交付 {a.deliveryId} · 成果版本 {a.artifactRevision} · 验收条件版本 {a.criteriaRevision}
      {a.evidence.length > 0 && ` · ${a.evidence.length} 条验证证据`}{a.issues.length > 0 && ` · 问题：${a.issues.join("；")}`}
    </p>)}
    <h4>步骤处理方式</h4>
    {p.mappings?.map(m => <p key={m.nodeId}>{base?.graph.nodes.find(n => n.id === m.nodeId)?.name ?? m.nodeId}：{m.action === "retain" ? "保留" : m.action === "replace" ? "替换" : "删除"}</p>) ?? <p>映射缺失，不能批准。</p>}
    </details>
    <button disabled={pending || p.status !== "proposed" || !!stale.length} onClick={() => {
      if (confirm(`已检查固定提案 ${p.id} 自身的图、提示词、尝试/任务、批准影响和映射？仅批准应用到 ${p.runId}，相关任务将先等待安全边界。`)) void mutate({ type: "patch.apply", payload: { patchId: p.id } });
    }}>确认批准并在安全时应用</button>
    {s.messages.filter(m => p.notificationIds?.includes(m.id)).map(m => <p role="alert" key={m.id}>通知状态：{m.status} · {m.error}</p>)}
  </article>;
}
