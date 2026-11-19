import { randomUUID } from "node:crypto";
import type { ActorContext, Delivery, Run, StageAttempt, TeamflowCommand, TeamflowSnapshot, WorkflowNode } from "../../packages/protocol/src/index.js";
import { patchBlocks } from "./patches.js";
import { recoveryBlocks } from "./execution-fence.js";
import { escalate } from "./escalation.js";
export const now = () => new Date().toISOString();
export const uid = () => randomUUID();
export function audit(s: TeamflowSnapshot, type: string, actor: ActorContext, detail: string) {
  s.audit.push({ id: uid(), at: now(), type, actor: actor.kind === "agent" ? actor.sessionId : actor.kind, detail });
}
export const versionFor = (s: TeamflowSnapshot, run: Run) => {
  const v = s.versions.find(v => v.id === run.versionId);
  if (!v) throw new Error("Run version missing"); return v;
};
export const current = (s: TeamflowSnapshot, runId: string, nodeId: string) => s.attempts.filter(a => a.runId === runId && a.nodeId === nodeId).sort((a, b) => b.round - a.round)[0];
export const attemptVersion = (s: TeamflowSnapshot, a: StageAttempt) => s.versions.find(v => v.id === (a.versionId ?? s.runs.find(r => r.id === a.runId)?.versionId))!;
export function assertCurrent(s: TeamflowSnapshot, attemptId: string, allowCompleted = false) {
  const a = s.attempts.find(a => a.id === attemptId);
  if (!a || a.supersededBy || current(s, a.runId, a.nodeId)?.id !== a.id || ["superseded", "cancelled", "needs_revision", "failed"].includes(a.status)) throw new Error("Stale or inactive attempt");
  const run = s.runs.find(r => r.id === a.runId)!;
  if (["cancelled", "failed"].includes(run.status) || (run.status === "completed" && !allowCompleted)) throw new Error("Run is terminal");
  return { attempt: a, run, node: attemptVersion(s, a).graph.nodes.find(n => n.id === a.nodeId)! };
}
export function sourceDelivery(s: TeamflowSnapshot, run: Run, node: WorkflowNode) {
  const source = current(s, run.id, node.sourceNodeId!);
  const d = source && s.deliveries.findLast(d => d.attemptId === source.id);
  if (!d) throw new Error("Current source delivery missing");
  return d;
}
export function verifyBinding(d: Delivery, p: { deliveryId: string; artifactRevision: string; criteriaRevision: string }) {
  if (d.id !== p.deliveryId || d.artifactRevision !== p.artifactRevision || d.criteriaRevision !== p.criteriaRevision) throw new Error("Artifact/criteria version mismatch");
}
export function automaticReturns(s: TeamflowSnapshot, a: StageAttempt): number {
  if (a.reworkCount !== undefined) return a.reworkCount;
  const prior = a.previousAttemptId && s.attempts.find(x => x.id === a.previousAttemptId);
  return prior ? automaticReturns(s, prior) + (a.reason?.startsWith("User correction ") ? 0 : 1) : 0;
}
function newAttempt(s: TeamflowSnapshot, run: Run, node: WorkflowNode, old?: StageAttempt, reason?: string) {
  const a: StageAttempt = { id: uid(), runId: run.id, nodeId: node.id, versionId: run.versionId, round: (old?.round ?? 0) + 1, status: "pending",
    criteriaRevision: old?.criteriaRevision ?? node.criteriaRevision, ...(old?.requirements ? { requirements: old.requirements } : {}),
    reworkCount: old ? automaticReturns(s, old) + 1 : 0, createdAt: now(), ...(old ? { previousAttemptId: old.id } : {}), ...(reason ? { reason } : {}) };
  s.attempts.push(a); return a;
}
export function startAttempts(s: TeamflowSnapshot, run: Run) {
  for (const node of versionFor(s, run).graph.nodes) newAttempt(s, run, node);
}
export function returnForRevision(s: TeamflowSnapshot, run: Run, from: WorkflowNode, reason: string) {
  const v = versionFor(s, run), choices = v.graph.edges.filter(e => e.from === from.id && e.kind === "return");
  if (choices.length > 1) throw new Error(`Ambiguous return edges from ${from.id}: Demo supports one return target, never arbitrary first-edge execution`);
  const edge = choices[0];
  const targetId = edge?.to ?? from.sourceNodeId ?? from.id;
  const target = current(s, run.id, targetId)!;
  if (run.status === "completed") run.status = "running";
  const affected = new Set([targetId, from.id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const e of v.graph.edges.filter(e => e.kind === "normal")) if (affected.has(e.from) && !affected.has(e.to)) { affected.add(e.to); changed = true; }
  }
  const affectedAttempts = s.attempts.filter(a => a.runId === run.id && affected.has(a.nodeId) && current(s, run.id, a.nodeId)?.id === a.id);
  for (const a of affectedAttempts) a.status = a.id === target.id ? "needs_revision" : "superseded";
  for (const approval of s.approvals) if (affectedAttempts.some(a => a.id === approval.attemptId || a.id === approval.targetAttemptId)) approval.valid = false;
  for (const task of s.tasks) if (affectedAttempts.some(a => a.id === task.attemptId)) {
    if (task.child) { task.child.staleBy = `rework:${target.id}`; if (task.status === "submitted") continue; }
    if (["cancelled", "superseded"].includes(task.status)) continue;
    task.status = "superseded";
  }
  if (!edge || automaticReturns(s, target) >= run.config.reworkAttempts) {
    escalate(run, `Escalation: ${!edge ? "no return edge" : "rework budget exhausted"}: ${reason}`, affectedAttempts.map(a => a.id)); return;
  }
  for (const a of affectedAttempts) newAttempt(s, run, v.graph.nodes.find(n => n.id === a.nodeId)!, a, reason);
  audit(s, "attempt.rework", { kind: "system" }, `${run.id}: ${from.id} → ${edge.to}: ${reason}`);
}
export function gatePrerequisitesSatisfied(s: TeamflowSnapshot, run: Run, n: WorkflowNode) {
  const d = sourceDelivery(s, run, n), g = n.gate!;
  if (d.unresolved.length || d.checks.some(c => c.exitCode !== 0)) return false;
  const approvals = s.approvals.filter(p => p.valid && p.runId === run.id && p.targetAttemptId === d.attemptId && p.deliveryId === d.id && p.artifactRevision === d.artifactRevision && p.criteriaRevision === d.criteriaRevision);
  if (approvals.some(p => p.kind !== "user" && p.verdict !== "pass")) return false;
  return g.reviewRoles.every(role => approvals.some(p => p.kind === "review" && p.role === role && p.verdict === "pass")) &&
    g.testRoles.every(role => approvals.some(p => p.kind === "test" && p.role === role && p.verdict === "pass" && p.evidence.length > 0 && p.evidence.every(e => e.exitCode === 0 && e.version === d.artifactRevision && e.source === "independent_execution")));
}
function gateSatisfied(s: TeamflowSnapshot, run: Run, a: StageAttempt, n: WorkflowNode) {
  const d = sourceDelivery(s, run, n);
  return gatePrerequisitesSatisfied(s, run, n) && (!n.gate!.user || s.approvals.some(p => p.valid && p.kind === "user" && p.attemptId === a.id && p.deliveryId === d.id && p.verdict === "pass"));
}
export function advance(s: TeamflowSnapshot) {
  for (const run of s.runs) {
    if (!["running", "waiting"].includes(run.status)) continue;
    const v = versionFor(s, run);
    let changed = true;
    while (changed) {
      changed = false;
      for (const n of v.graph.nodes) {
        const a = current(s, run.id, n.id)!;
        if (patchBlocks(s, run.id, n.id)) continue;
        if (a.supersededBy) continue;
        if (a.status === "pending" && v.graph.edges.filter(e => e.kind === "normal" && e.to === n.id).every(e => {
          const predecessor = current(s, run.id, e.from);
          return predecessor?.status === "passed" && !predecessor.supersededBy;
        })) {
          a.status = n.kind === "end" ? "passed" : n.kind === "gate" ? "awaiting_gate" : "ready"; changed = true;
        }
        if (a.status === "awaiting_gate" && n.kind === "gate" && gateSatisfied(s, run, a, n)) { a.status = "passed"; changed = true; }
      }
    }
    const attempts = v.graph.nodes.map(n => current(s, run.id, n.id)!);
    const patches = s.patches.filter(p => p.runId === run.id && ["waiting_boundary", "review_required"].includes(p.status));
    if (!patches.length && attempts.every(a => a.status === "passed" && !a.supersededBy)) { run.status = "completed"; delete run.waitingReason; }
    else if (attempts.some(a => !a.supersededBy && (a.status === "ready" || a.status === "running"))) { run.status = "running"; delete run.waitingReason; }
    else { run.status = "waiting"; run.waitingReason = [
      ...patches.map(p => p.status === "review_required" ? `Approved workflow patch ${p.id}: user re-review required; ${p.reviewRequired?.reason ?? "inspect saved patch"}` : `Approved workflow patch ${p.id}: waiting for affected native safe boundary`),
      ...attempts.filter(a => !a.supersededBy && (a.status === "awaiting_gate" || a.status === "failed")).map(a => `${a.nodeId}: ${a.status === "failed" ? a.reason ?? "failed" : "required user approval / professional checks"}`),
    ].join("; ") || "Waiting for dependencies"; }
  }
}
type CoreCommand = Extract<TeamflowCommand, { type: "task.submit" | "review.submit" | "gate.approve" | "gate.reject" }>;
export function executeSubmission(s: TeamflowSnapshot, command: CoreCommand, actor: ActorContext) {
  const { attempt: a, run, node } = assertCurrent(s, command.payload.attemptId, command.type === "review.submit");
  if (command.payload.criteriaRevision !== a.criteriaRevision) throw new Error("Attempt criteria revision mismatch");
  if (command.type === "gate.approve" || command.type === "gate.reject") {
    if (actor.kind !== "user") throw new Error("Forbidden: user Gate requires trusted user entrypoint");
    if (node.kind !== "gate" || !node.gate?.user || a.status !== "awaiting_gate") throw new Error("Gate is not awaiting user approval");
    const d = sourceDelivery(s, run, node); verifyBinding(d, command.payload);
    const previous = s.approvals.filter(x => x.attemptId === a.id && x.kind === "user" && x.valid);
    if (command.type === "gate.approve") {
      if (!gatePrerequisitesSatisfied(s, run, node)) throw new Error("Gate prerequisites unmet: unresolved issues, failed self checks or missing professional checks");
      if (previous.length) throw new Error("User decision already recorded");
    } else {
      // A paused/not-yet-passed Gate can still be rejected after an earlier approval.
      // Preserve the previous decision, explicitly invalidating it with an audit trail.
      for (const prior of previous) prior.valid = false;
      if (previous.length) audit(s, "gate.user_decision_superseded", actor, JSON.stringify({ attemptId: a.id, approvalIds: previous.map(p => p.id), reason: command.payload.reason }));
    }
    s.approvals.push({ id: uid(), runId: run.id, attemptId: a.id, targetAttemptId: d.attemptId, deliveryId: d.id, artifactRevision: d.artifactRevision, criteriaRevision: d.criteriaRevision, kind: "user", actorId: "user", verdict: command.type === "gate.approve" ? "pass" : "needs_revision", issues: command.type === "gate.reject" ? [command.payload.reason] : [], evidence: [], valid: true, createdAt: now() });
    if (command.type === "gate.reject") returnForRevision(s, run, node, command.payload.reason);
    return;
  }
  if (actor.kind !== "agent") throw new Error("Forbidden: real member tool session required");
  const member = s.members.find(m => m.sessionId === actor.sessionId && m.runId === run.id);
  const task = s.tasks.find(t => t.attemptId === a.id && t.memberId === member?.id);
  const lateVeto = command.type === "review.submit" && command.payload.verdict !== "pass" &&
    ["review", "test"].includes(node.kind) && a.status === "passed" &&
    task?.status === "submitted" && task.executionMode === "conversation" &&
    task.slotHeld && !recoveryBlocks(task) &&
    s.messages.some(m => m.runId === run.id && m.to === member?.id && m.continuationAuthorized &&
      ["delivered", "acknowledged"].includes(m.status) &&
      ["accepted", "observed_inbox", "observed_context"].includes(m.admission ?? "") &&
      m.request?.state === "settled") &&
    s.approvals.some(p => p.valid && p.attemptId === a.id && p.actorId === actor.sessionId && p.verdict === "pass");
  if (!member || member.legacy || !task || task.sessionId !== actor.sessionId || member.taskId !== task.id ||
    task.child || member.role !== node.role ||
    (!lateVeto && (task.executionMode === "conversation" || task.status !== "running"))) throw new Error("Forbidden: caller does not own active workflow execution; admitted current professional conversation may only veto its existing pass");
  if (command.type === "task.submit") {
    const p = command.payload;
    if (node.kind !== "work" || a.status !== "running" || task.status !== "running" || p.taskId !== task.id || p.criteriaRevision !== a.criteriaRevision) throw new Error("Invalid work submission or criteria revision");
    if (p.checks.some(c => c.version !== p.artifactRevision || c.source !== "self_report")) throw new Error("Self checks must identify current artifact and self_report provenance");
    s.deliveries.push({ id: uid(), runId: run.id, attemptId: a.id, memberId: member.id, sessionId: actor.sessionId, artifactRevision: p.artifactRevision, criteriaRevision: p.criteriaRevision, artifacts: p.artifacts, summary: p.summary, checks: p.checks, unresolved: p.unresolved, createdAt: now() });
    task.status = "submitted"; task.executionMode = "conversation";
    // "passed" here completes the work node, not acceptance. Its blocking evidence
    // remains attached and prevents the actual Gate; independent checks may return it.
    a.status = "passed";
    return;
  }
  const p = command.payload;
  if (!["review", "test"].includes(node.kind) || !["running", "passed"].includes(a.status)) throw new Error("Not an active professional check");
  const d = sourceDelivery(s, run, node); verifyBinding(d, p);
  if (d.staleBy || (lateVeto && !s.approvals.some(x => x.valid && x.attemptId === a.id && x.actorId === actor.sessionId &&
    x.verdict === "pass" && x.deliveryId === d.id && x.targetAttemptId === d.attemptId &&
    x.artifactRevision === d.artifactRevision && x.criteriaRevision === d.criteriaRevision))) throw new Error("Late veto must retain its current reviewed source binding");
  if (d.attemptId !== p.targetAttemptId || d.sessionId === actor.sessionId) throw new Error("Independent check must target the current artifact from a different session");
  if (p.evidence.some(e => e.version !== d.artifactRevision || e.source !== "independent_execution")) throw new Error("Independent evidence version/provenance mismatch");
  if (p.verdict === "pass" && (p.issues.length || (node.kind === "test" && (!p.evidence.length || p.evidence.some(e => e.exitCode !== 0))))) throw new Error("Passing check has unresolved issues or missing/failed tests");
  for (const old of s.approvals.filter(x => x.attemptId === a.id && x.actorId === actor.sessionId)) old.valid = false;
  s.approvals.push({ id: uid(), runId: run.id, attemptId: a.id, targetAttemptId: d.attemptId, deliveryId: d.id, artifactRevision: d.artifactRevision, criteriaRevision: d.criteriaRevision, kind: node.kind as "review" | "test", actorId: actor.sessionId, role: member.role, verdict: p.verdict, issues: p.issues, evidence: p.evidence, valid: true, createdAt: now() });
  task.status = "submitted"; task.executionMode = "conversation";
  if (p.verdict === "pass") a.status = "passed";
  else returnForRevision(s, run, node, `${p.verdict}: ${p.issues.join("; ") || "Professional check rejected"}`);
}
