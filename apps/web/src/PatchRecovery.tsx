import React, { useState } from "react";
import { patchImpact, type MutationResult, type TeamflowCommand, type TeamflowSnapshot, type WorkflowPatch } from "../../../packages/protocol/src/index";

const pretty = (value: unknown) => JSON.stringify(value, null, 2);
/** Re-proposal is NOT approval. The old block/invalidations stay in force until a
 * separately approved replacement actually switches at the native safe boundary. */
export function PatchRecovery({ patch: p, snapshot: s, pending, mutate }: {
  patch: WorkflowPatch; snapshot: TeamflowSnapshot; pending: boolean;
  mutate(c: TeamflowCommand): Promise<MutationResult | undefined>;
}) {
  const [versionId, setVersionId] = useState(p.proposedVersionId), [reason, setReason] = useState(`重新检查旧批准 ${p.id}：${p.reason}`);
  const run = s.runs.find(r => r.id === p.runId), base = s.versions.find(v => v.id === p.baseVersionId), next = s.versions.find(v => v.id === versionId);
  const previous = s.patches.find(x => x.id === p.replacementPatchId);
  const affected = base && next ? patchImpact(base, next, p.affectedNodeIds) : [];
  const attempts = s.attempts.filter(a => a.runId === p.runId && affected.includes(a.nodeId) && !s.attempts.some(b => b.runId === a.runId && b.nodeId === a.nodeId && b.round > a.round));
  const ids = attempts.map(a => a.id);
  const mappings = base?.graph.nodes.map(n => ({ nodeId: n.id, action: !affected.includes(n.id) ? "retain" : next?.graph.nodes.some(x => x.id === n.id) ? "replace" : "remove" }));
  const disabled = pending || !p.approvedAt || !base || !next || !run || run.versionId !== p.baseVersionId || ["completed", "cancelled", "failed"].includes(run.status) || !reason.trim() || !!previous && previous.status !== "proposed";
  return <section aria-label={`恢复检查 ${p.id}`}>
    <h4>旧批准需要重新检查（原阻塞及历史保持）</h4>
    <p role="alert">{p.reviewRequired?.reason ?? "已批准提案过时，不能自动扩大用户批准范围"}</p>
    <p>发现时间：{p.reviewRequired?.detectedAt ?? "未记录"}；旧批准时间：{p.approvedAt ?? "缺失"}。</p>
    <p>旧受影响节点仍阻塞：{p.affectedNodeIds.join(", ")}。重新提案不恢复旧任务/交付/批准，不释放原生租约；新的影响须在下方新提案中另行批准。</p>
    {previous && <p>关联恢复提案：{previous.id} · {previous.status}。
      {previous.status === "proposed" ? "可显式重新计算：先前未批准提案将作为 rejected 历史保留，只保留一个当前恢复提案。" : "已批准的恢复提案不能重复生成，请检查它的安全边界/状态。"}
    </p>}
    <label className="field">重新检查的目标发布版本<select value={versionId} onChange={e => setVersionId(e.target.value)}>
      {s.versions.filter(v => v.templateId === base?.templateId && v.id !== p.baseVersionId).map(v => <option key={v.id}>{v.id}</option>)}
    </select></label>
    <label className="field">恢复 / 重提原因<textarea value={reason} onChange={e => setReason(e.target.value)} /></label>
    <details open><summary>重新计算的图 / source / 任务 / 批准影响（预览，不是批准）</summary>
      <p>当前所需完整闭包：{affected.join(", ")}；保留旧阻塞范围，不能通过更换目标丢弃。</p>
      <h5>新影响下的当前尝试、任务与批准</h5>
      <pre>{pretty({ attempts, tasks: s.tasks.filter(t => t.runId === p.runId && ids.includes(t.attemptId)), approvals: s.approvals.filter(a => a.runId === p.runId && (ids.includes(a.attemptId) || ids.includes(a.targetAttemptId))), mappings })}</pre>
      <p>有效批准在应用新提案时失效；已失效批准保持失效；旧成员未送达通知仍保留。missing/unknown 不是安全证明。</p>
      <h5>基础图 / 角色提示词</h5><pre>{pretty(base ?? "缺失")}</pre>
      <h5>新目标图 / 角色提示词</h5><pre>{pretty(next ?? "缺失")}</pre>
    </details>
    <button disabled={disabled} onClick={() => {
      if (confirm(`仅为旧批准 ${p.id} 重新计算并记录一个未批准的恢复提案？旧阻塞/历史保持，${previous ? "先前未批准恢复提案保留为 rejected，" : ""}不会自动批准、应用或释放租约。请在新提案中另行检查并确认。`)) void mutate({
        type: "patch.repropose", payload: { patchId: p.id, replacementPatchId: `patch-recovery-${crypto.randomUUID()}`, proposedVersionId: versionId, reason },
      });
    }}>可信用户重新计算 / 记录恢复提案（不批准）</button>
  </section>;
}
