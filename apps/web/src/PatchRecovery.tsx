import React, { useState } from "react";
import { patchImpact, type MutationResult, type TeamflowCommand, type TeamflowSnapshot, type WorkflowPatch, type WorkflowVersion } from "../../../packages/protocol/src/index";

/** Compare the two immutable definitions rather than the current editor selection. */
export function DefinitionChanges({ base, next }: { base: WorkflowVersion; next: WorkflowVersion }) {
  const nodeName = (id: string) => next.graph.nodes.find(n => n.id === id)?.name ?? base.graph.nodes.find(n => n.id === id)?.name ?? id;
  const roleName = (id?: string) => id ? next.roles.find(r => r.id === id)?.agent ?? base.roles.find(r => r.id === id)?.agent ?? id : "未指定";
  const list = (items: string[]) => items.length ? items.join("、") : "无";
  const changes: React.ReactNode[] = [];
  const field = (key: string, label: string, before: string, after: string) => {
    if (before !== after) changes.push(<li key={key}><strong>{label}</strong><div>原来：{before || "无"}</div><div>现在：{after || "无"}</div></li>);
  };
  for (const id of new Set([...base.graph.nodes.map(n => n.id), ...next.graph.nodes.map(n => n.id)])) {
    const a = base.graph.nodes.find(n => n.id === id), b = next.graph.nodes.find(n => n.id === id);
    if (!a || !b) {
      const n = a ?? b!;
      changes.push(<li key={`node-${id}`}><strong>{a ? "删除步骤" : "新增步骤"}：{n.name}</strong><div>负责角色：{roleName(n.role)}</div><div>工作要求：{n.prompt}</div><div>验收条件：{list(n.criteria)}</div></li>);
      continue;
    }
    const title = a.name === b.name ? a.name : `${a.name} → ${b.name}`;
    field(`${id}-name`, "步骤名称", a.name, b.name);
    field(`${id}-kind`, `${title} · 步骤类型`, a.kind, b.kind);
    field(`${id}-role`, `${title} · 负责角色`, roleName(a.role), roleName(b.role));
    field(`${id}-prompt`, `${title} · 工作要求`, a.prompt, b.prompt);
    field(`${id}-criteria`, `${title} · 验收条件`, list(a.criteria), list(b.criteria));
    field(`${id}-input`, `${title} · 所需输入`, list(a.inputs), list(b.inputs));
    field(`${id}-output`, `${title} · 交付内容`, list(a.deliverables), list(b.deliverables));
    field(`${id}-mode`, `${title} · 执行模式`, a.mode, b.mode);
    field(`${id}-writes`, `${title} · 修改权限`, a.writes ? "可修改" : "只读", b.writes ? "可修改" : "只读");
    field(`${id}-source`, `${title} · 检查来源`, a.sourceNodeId ? nodeName(a.sourceNodeId) : "无", b.sourceNodeId ? nodeName(b.sourceNodeId) : "无");
    const gate = (n: typeof a) => n.gate ? `用户确认：${n.gate.user ? "需要" : "不需要"}；审核角色：${list(n.gate.reviewRoles.map(roleName))}；测试角色：${list(n.gate.testRoles.map(roleName))}` : "无";
    field(`${id}-gate`, `${title} · 审批要求`, gate(a), gate(b));
    field(`${id}-revision`, `${title} · 验收条件版本`, a.criteriaRevision, b.criteriaRevision);
  }
  for (const id of new Set([...base.roles.map(r => r.id), ...next.roles.map(r => r.id)])) {
    const a = base.roles.find(r => r.id === id), b = next.roles.find(r => r.id === id);
    if (!a || !b) {
      const r = a ?? b!;
      changes.push(<li key={`role-${id}`}><strong>{a ? "移除角色" : "新增角色"}：{r.agent}</strong><div>职责：{r.responsibility}</div><div>角色提示词：{r.prompt}</div></li>);
      continue;
    }
    const title = a.agent === b.agent ? a.agent : `${a.agent} → ${b.agent}`;
    field(`${id}-agent`, "角色名称", a.agent, b.agent);
    field(`${id}-responsibility`, `${title} · 职责`, a.responsibility, b.responsibility);
    field(`${id}-roleprompt`, `${title} · 角色提示词`, a.prompt, b.prompt);
    field(`${id}-skills`, `${title} · 技能`, list(a.skills), list(b.skills));
    field(`${id}-permissions`, `${title} · 权限`, list(a.permissions), list(b.permissions));
    field(`${id}-children`, `${title} · 可委派角色`, list(a.childRoles.map(roleName)), list(b.childRoles.map(roleName)));
    field(`${id}-depth`, `${title} · 委派层数`, String(a.maxDepth), String(b.maxDepth));
    field(`${id}-model`, `${title} · 模型`, a.model ? `${a.model.providerID} / ${a.model.id}` : "默认", b.model ? `${b.model.providerID} / ${b.model.id}` : "默认");
  }
  const edges = (v: WorkflowVersion) => v.graph.edges.map(e => `${nodeName(e.from)} → ${nodeName(e.to)}${e.kind === "return" ? "（退回）" : ""}`).sort();
  field("edges", "步骤之间的连接", list(edges(base)), list(edges(next)));
  field("entry", "起始步骤", nodeName(base.graph.entry), nodeName(next.graph.entry));
  field("gates", "必须经过的确认步骤", list(base.graph.requiredGateIds.map(nodeName)), list(next.graph.requiredGateIds.map(nodeName)));
  return <section aria-label="方案变动"><h4>方案变动</h4>{changes.length ? <ul>{changes}</ul> : <p>步骤、角色和连接没有可见变动。</p>}</section>;
}
/** Re-proposal is NOT approval. The old block/invalidations stay in force until a
 * separately approved replacement actually switches at the native safe boundary. */
export function PatchRecovery({ patch: p, snapshot: s, pending, mutate }: {
  patch: WorkflowPatch; snapshot: TeamflowSnapshot; pending: boolean;
  mutate(c: TeamflowCommand): Promise<MutationResult | undefined>;
}) {
  const [versionId, setVersionId] = useState(p.proposedVersionId), [reason, setReason] = useState(`重新检查旧批准：${p.reason}`);
  const run = s.runs.find(r => r.id === p.runId), base = s.versions.find(v => v.id === p.baseVersionId), next = s.versions.find(v => v.id === versionId);
  const previous = s.patches.find(x => x.id === p.replacementPatchId);
  const affected = base && next ? patchImpact(base, next, p.affectedNodeIds) : [];
  const attempts = s.attempts.filter(a => a.runId === p.runId && affected.includes(a.nodeId) && !s.attempts.some(b => b.runId === a.runId && b.nodeId === a.nodeId && b.round > a.round));
  const ids = attempts.map(a => a.id);
  const approvals = s.approvals.filter(a => a.runId === p.runId && (ids.includes(a.attemptId) || ids.includes(a.targetAttemptId)));
  const disabled = pending || !p.approvedAt || !base || !next || !run || run.versionId !== p.baseVersionId || ["completed", "cancelled", "failed"].includes(run.status) || !reason.trim() || !!previous && previous.status !== "proposed";
  return <section aria-label={`恢复检查 ${p.id}`}>
    <h4>旧批准需要重新检查（原阻塞及历史保持）</h4>
    <p role="alert">{p.reviewRequired?.reason ?? "已批准提案过时，不能自动扩大用户批准范围"}</p>
    <p>发现时间：{p.reviewRequired?.detectedAt ?? "未记录"}；旧批准时间：{p.approvedAt ?? "缺失"}。</p>
    <p>原来受影响的 {p.affectedNodeIds.length} 个步骤仍被阻塞。重新提案不会恢复旧任务、交付或批准；新的影响须另行批准。</p>
    {previous && <p>已有重新检查的提案：{previous.status}。
      {previous.status === "proposed" ? "可显式重新计算：先前未批准提案将作为 rejected 历史保留，只保留一个当前恢复提案。" : "已批准的恢复提案不能重复生成，请检查它的安全边界/状态。"}
    </p>}
    <label className="field">重新检查的目标发布版本<select value={versionId} onChange={e => setVersionId(e.target.value)}>
      {s.versions.filter(v => v.templateId === base?.templateId && v.id !== p.baseVersionId).map((v, i) => <option key={v.id} value={v.id}>已发布版本 {i + 1}{v.releaseNotes ? ` · ${v.releaseNotes}` : ""}</option>)}
    </select></label>
    <label className="field">恢复 / 重提原因<textarea value={reason} onChange={e => setReason(e.target.value)} /></label>
    <p>重新计算涉及 {affected.length} 个步骤、{attempts.length} 个当前执行记录。记录新提案不会自动批准或应用。</p>
    {base && next && <DefinitionChanges base={base} next={next} />}
    <p>受影响步骤：{affected.map(id => base?.graph.nodes.find(n => n.id === id)?.name ?? next?.graph.nodes.find(n => n.id === id)?.name ?? id).join("、") || "无"}。原阻塞范围仍保留。</p>
    <p>关联批准：{approvals.filter(a => a.valid).length} 项有效、{approvals.filter(a => !a.valid).length} 项已失效。有效批准在应用新提案时失效，已失效批准不会恢复。</p>
    <button disabled={disabled} onClick={() => {
      if (confirm(`仅为旧批准 ${p.id} 重新计算并记录一个未批准的恢复提案？旧阻塞/历史保持，${previous ? "先前未批准恢复提案保留为 rejected，" : ""}不会自动批准、应用或释放租约。请在新提案中另行检查并确认。`)) void mutate({
        type: "patch.repropose", payload: { patchId: p.id, replacementPatchId: `patch-recovery-${crypto.randomUUID()}`, proposedVersionId: versionId, reason },
      });
    }}>可信用户重新计算 / 记录恢复提案（不批准）</button>
  </section>;
}
