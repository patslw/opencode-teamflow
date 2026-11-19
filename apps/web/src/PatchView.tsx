import React, { useState } from "react";
import type { MutationResult, TeamflowCommand, TeamflowSnapshot } from "../../../packages/protocol/src/index";
import { patchImpact as impact } from "../../../packages/protocol/src/index";
import { PatchProposal } from "./PatchProposal";

const pretty = (v: unknown) => JSON.stringify(v, null, 2);
// Preview is advisory; backend independently computes and validates the impact.
export function PatchView({ snapshot: s, runId, pending, mutate }: {
  snapshot: TeamflowSnapshot; runId: string; pending: boolean;
  mutate(c: TeamflowCommand): Promise<MutationResult | undefined>;
}) {
  const [targetId, setTargetId] = useState(""), [reason, setReason] = useState("");
  const run = s.runs.find(r => r.id === runId)!, base = s.versions.find(v => v.id === run.versionId)!;
  const next = s.versions.find(v => v.id === targetId && v.templateId === base.templateId);
  const affected = next ? impact(base, next) : [];
  const mappings = base.graph.nodes.map(n => ({
    nodeId: n.id, action: !affected.includes(n.id) ? "retain" as const : next?.graph.nodes.some(x => x.id === n.id) ? "replace" as const : "remove" as const,
  }));
  return <section aria-label="工作流 patch">
    <h2>单实例 patch / 图与提示词影响比较</h2>
    <p>仅应用到 {run.id}。旧尝试、会话、交付、子任务完成事实保留；相关批准失效。定义回退不撤销代码。相关任务等待真实原生安全边界，其他工作/实例不升级。</p>
    <label className="field">目标发布版本<select value={targetId} onChange={e => setTargetId(e.target.value)}>
      <option value="">先在独立设计草稿中修改并由用户发布</option>
      {s.versions.filter(v => v.templateId === base.templateId && v.id !== base.id).map(v => <option key={v.id}>{v.id}</option>)}
    </select></label>
    <label className="field">必要性 / 原因<textarea value={reason} onChange={e => setReason(e.target.value)} /></label>
    {next && <>
      <h3>影响节点（后端重新计算）</h3><p>{affected.join(", ") || "无执行定义变更"}</p>
      <details open><summary>图 / 节点 / Gate / 提示词差异</summary>
        <h4>旧 graph</h4><pre>{pretty(base.graph)}</pre><h4>新 graph</h4><pre>{pretty(next.graph)}</pre>
        <h4>旧角色 / 提示词 / Skill / 模型 / 权限</h4><pre>{pretty(base.roles)}</pre><h4>新角色配置</h4><pre>{pretty(next.roles)}</pre>
      </details>
      <h3>保留 / 替代 / 删除映射（同 ID，增节点创建新尝试）</h3><pre>{pretty(mappings)}</pre>
      <p>受影响任务：{s.tasks.filter(t => s.attempts.some(a => a.id === t.attemptId && a.runId === runId && affected.includes(a.nodeId))).map(t => `${t.id} (${t.status}, lease=${t.slotHeld})`).join("; ") || "尚未派工"}</p>
      <p>需重新批准：{s.approvals.filter(p => p.runId === runId && p.valid && s.attempts.some(a => (a.id === p.attemptId || a.id === p.targetAttemptId) && affected.includes(a.nodeId))).map(p => p.id).join(", ") || "无有效批准"}</p>
      <button disabled={pending || !reason.trim() || ["completed", "failed", "cancelled"].includes(run.status)} onClick={() => void mutate({ type: "patch.propose", payload: { patch: {
        id: `patch-${crypto.randomUUID()}`, runId, baseVersionId: base.id, proposedVersionId: next.id, reason,
        affectedNodeIds: affected, mappings, status: "proposed",
      } } })}>记录提案（尚不应用）</button>
    </>}
    {s.patches.filter(p => p.runId === runId).map(p => <PatchProposal key={p.id} patch={p} snapshot={s} pending={pending} mutate={mutate} />)}
  </section>;
}
