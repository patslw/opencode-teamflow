import React, { useState } from "react";
import type { MutationResult, TeamflowCommand, TeamflowSnapshot } from "../../../packages/protocol/src/index";
import { patchImpact as impact } from "../../../packages/protocol/src/index";
import { PatchProposal } from "./PatchProposal";
import { DefinitionChanges } from "./PatchRecovery";

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
  return <section aria-label="工作流 patch" className="flow-design">
    <h2>将已发布方案用于当前工作</h2>
    <p>先比较并记录提案，再单独确认应用。只影响当前工作；其他工作不会升级。已有工作记录会保留，相关批准需要重新确认。</p>
    <label className="field">目标发布版本<select value={targetId} onChange={e => setTargetId(e.target.value)}>
      <option value="">先在独立设计草稿中修改并由用户发布</option>
      {s.versions.filter(v => v.templateId === base.templateId && v.id !== base.id).map((v, i) => <option key={v.id} value={v.id}>已发布版本 {i + 1}{v.releaseNotes ? ` · ${v.releaseNotes}` : ""}</option>)}
    </select></label>
    <label className="field">为什么要变更？<textarea value={reason} onChange={e => setReason(e.target.value)} /></label>
    {next && <>
      <h3>变更影响预览</h3><p>{affected.length ? `有 ${affected.length} 个步骤受影响，后端会再次核对。` : "没有执行定义变更。"}</p>
      <DefinitionChanges base={base} next={next} />
      <p>受影响任务：{s.tasks.filter(t => s.attempts.some(a => a.id === t.attemptId && a.runId === runId && affected.includes(a.nodeId))).length} 项；需要重新确认的有效批准：{s.approvals.filter(p => p.runId === runId && p.valid && s.attempts.some(a => (a.id === p.attemptId || a.id === p.targetAttemptId) && affected.includes(a.nodeId))).length} 项。</p>
      <button disabled={pending || !reason.trim() || ["completed", "failed", "cancelled"].includes(run.status)} onClick={() => void mutate({ type: "patch.propose", payload: { patch: {
        id: `patch-${crypto.randomUUID()}`, runId, baseVersionId: base.id, proposedVersionId: next.id, reason,
        affectedNodeIds: affected, mappings, status: "proposed",
      } } })}>记录应用提案（暂不应用）</button>
    </>}
    {s.patches.filter(p => p.runId === runId).map(p => <PatchProposal key={p.id} patch={p} snapshot={s} pending={pending} mutate={mutate} />)}
  </section>;
}
