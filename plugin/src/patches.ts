import type { ActorContext, Run, TeamflowCommand, TeamflowSnapshot, WorkflowPatch, WorkflowVersion } from "../../packages/protocol/src/index.js";
import { audit, automaticReturns, current, now, uid, versionFor } from "./engine.js";
import { recoveryBlocks, unresolvedIO } from "./execution-fence.js";
import { enqueue } from "./collaboration.js";
import type { TeamflowStore } from "./store.js";
import { validateVersion } from "./model.js";
import { patchImpact } from "../../packages/protocol/src/workflow-diff.js";
import { preserveLegacyEscalation, resolutionBasis, resolveEscalation } from "./escalation.js";
export { patchImpact } from "../../packages/protocol/src/workflow-diff.js";

const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** Resolve effective correction bases independently of graph array order.
 * Redirecting a corrected check to a differently corrected source cannot silently
 * discard/transfer requirements; reject that unsupported migration explicitly. */
function replacementBases(s: TeamflowSnapshot, run: Run, next: WorkflowVersion, affected: string[]) {
  const bases = new Map<string, { criteriaRevision: string; requirements?: string }>();
  const resolve = (nodeId: string): { criteriaRevision: string; requirements?: string } => {
    const prior = bases.get(nodeId);
    if (prior) return prior;
    const n = next.graph.nodes.find(n => n.id === nodeId)!;
    const old = current(s, run.id, n.id);
    let basis = old?.requirements ? { criteriaRevision: old.criteriaRevision, requirements: old.requirements } : { criteriaRevision: n.criteriaRevision };
    if (n.sourceNodeId) {
      const source = resolve(n.sourceNodeId);
      if (old?.requirements && (old.criteriaRevision !== source.criteriaRevision || old.requirements !== source.requirements)) throw new Error(`Unsupported effective criteria binding for ${n.id} -> ${n.sourceNodeId}: existing user correction differs from source; preserve a common source/correction basis before proposing this patch`);
      basis = source;
    }
    bases.set(nodeId, basis);
    return basis;
  };
  next.graph.nodes.filter(n => affected.includes(n.id)).forEach(n => resolve(n.id));
  return bases;
}
const blocking = (p: WorkflowPatch) => ["waiting_boundary", "review_required"].includes(p.status);
function recoveryParent(s: TeamflowSnapshot, p: WorkflowPatch) {
  if (!p.replacesPatchId) return undefined;
  const parent = s.patches.find(x => x.id === p.replacesPatchId);
  if (!parent || parent.status !== "review_required" || parent.replacementPatchId !== p.id || parent.runId !== p.runId || parent.baseVersionId !== p.baseVersionId) throw new Error("Recovery proposal is no longer the current replacement; inspect its original patch");
  return parent;
}
function recoveryChain(s: TeamflowSnapshot, p: WorkflowPatch) {
  const chain: WorkflowPatch[] = [], seen = new Set([p.id]);
  let cursor = p;
  while (cursor.replacesPatchId) {
    const parent = recoveryParent(s, cursor)!;
    if (seen.has(parent.id)) throw new Error("Invalid patch recovery cycle");
    seen.add(parent.id); chain.push(parent); cursor = parent;
  }
  return chain;
}
function propose(s: TeamflowSnapshot, p: WorkflowPatch, actor: ActorContext, parent?: WorkflowPatch) {
    const run = s.runs.find(r => r.id === p.runId);
    if (!run || ["cancelled", "failed", "completed"].includes(run.status) || run.versionId !== p.baseVersionId) throw new Error("Patch base/run is stale or terminal");
    const ancestors = parent ? [parent, ...recoveryChain(s, parent)] : [];
    if (s.patches.some(x => x.id === p.id || x.runId === run.id && blocking(x) && !ancestors.includes(x))) throw new Error("Patch ID exists or run already awaits patch boundary/re-review");
    const base = versionFor(s, run), next = s.versions.find(v => v.id === p.proposedVersionId);
    if (!next || next.templateId !== base.templateId || next.id === base.id) throw new Error("Patch requires another published version of the same template");
    validateVersion(next);
    const affected = patchImpact(base, next, parent?.affectedNodeIds);
    replacementBases(s, run, next, affected);
    if (actor.kind !== "user") {
      const d = s.drafts.find(d => d.id === p.draftId);
      if (actor.kind !== "agent" || d?.designer?.state !== "ready" || d.designer.sessionId !== actor.sessionId ||
        d.baseVersionId !== base.id || !equal(d.graph, next.graph) || !equal(d.roles, next.roles)) throw new Error("Designer may only propose its own authorized draft content");
    }
    const mappings = p.mappings ?? [];
    if (!equal([...p.affectedNodeIds].sort(), affected)) throw new Error(`Impact mismatch; required nodes: ${affected.join(",")}`);
    if (mappings.length !== base.graph.nodes.length || new Set(mappings.map(m => m.nodeId)).size !== mappings.length ||
      base.graph.nodes.some(n => !mappings.some(m => m.nodeId === n.id))) throw new Error("Explicit retain/replace/remove mapping required for every old node");
    for (const m of mappings) {
      if (m.action === "retain" && (affected.includes(m.nodeId) || !next.graph.nodes.some(n => n.id === m.nodeId))) throw new Error("Changed/dependent work cannot be retained as current");
      if (m.action === "remove" && next.graph.nodes.some(n => n.id === m.nodeId)) throw new Error("Existing next node must be replaced, not removed");
      if (m.action === "remove" && current(s, run.id, m.nodeId)?.requirements) throw new Error("Cannot remove a node with effective user corrections in this Demo; preserve its ID/requirements or resolve the correction explicitly");
      if (m.action === "replace" && (m.replacementNodeId ?? m.nodeId) !== m.nodeId) throw new Error("Demo supports same-ID replacement only; remove/add nodes instead (no implicit requirements transfer)");
      if (m.action === "replace" && !next.graph.nodes.some(n => n.id === m.nodeId)) throw new Error("Replacement node missing");
      if (!affected.includes(m.nodeId) && m.action !== "retain") throw new Error("Unchanged work must be retained");
    }
    s.patches.push({ id: p.id, runId: run.id, baseVersionId: base.id, proposedVersionId: next.id, draftId: p.draftId, reason: p.reason, affectedNodeIds: affected, mappings, status: "proposed", ...(parent ? { replacesPatchId: parent.id } : {}),
      affectedAttemptIds: s.attempts.filter(a => a.runId === run.id && affected.includes(a.nodeId) && current(s, run.id, a.nodeId)?.id === a.id).map(a => a.id),
    });
}
/** User recovery creates a NEW, unapproved proposal; never edits the old scope or
 * grants approval. Only an unapproved previous replacement may be retired. */
export function patchCommand(s: TeamflowSnapshot, c: TeamflowCommand, actor: ActorContext): boolean {
  if (c.type === "patch.propose") {
    if (c.payload.patch.replacesPatchId) throw new Error("Recovery links require trusted-user patch.repropose");
    propose(s, c.payload.patch, actor);
    return true;
  }
  if (c.type === "patch.repropose") {
    if (actor.kind !== "user") throw new Error("Only trusted user may recover/re-propose an approved patch");
    const old = s.patches.find(p => p.id === c.payload.patchId);
    if (!old || old.status !== "review_required" || !old.approvedAt) throw new Error("Patch is not an approved review-required patch");
    const previous = s.patches.find(p => p.id === old.replacementPatchId);
    if (previous && previous.status !== "proposed") throw new Error("Recovery already approved/settled; inspect the current replacement, do not duplicate it");
    const run = s.runs.find(r => r.id === old.runId);
    const base = s.versions.find(v => v.id === old.baseVersionId), next = s.versions.find(v => v.id === c.payload.proposedVersionId);
    if (!run || !base || !next) throw new Error("Recovery run/base/target missing; no automatic replacement");
    const affected = patchImpact(base, next, old.affectedNodeIds);
    const proposal: WorkflowPatch = {
      id: c.payload.replacementPatchId, runId: old.runId, baseVersionId: old.baseVersionId,
      proposedVersionId: next.id, reason: c.payload.reason, affectedNodeIds: affected, status: "proposed",
      mappings: base.graph.nodes.map(n => ({ nodeId: n.id, action: !affected.includes(n.id) ? "retain" : next.graph.nodes.some(x => x.id === n.id) ? "replace" : "remove" })),
    };
    // propose() is transactional. A failed recomputation must not retire anything.
    propose(s, proposal, actor, old);
    if (previous) {
      previous.status = "rejected";
      audit(s, "patch.unapproved_recovery_replaced", actor, JSON.stringify({ oldPatchId: old.id, previousProposalId: previous.id, replacementPatchId: proposal.id }));
    }
    old.replacementPatchId = proposal.id;
    return true;
  }
  if (c.type === "patch.apply") {
    if (actor.kind !== "user") throw new Error("Only user may approve/apply a patch");
    const p = s.patches.find(p => p.id === c.payload.patchId);
    if (!p || p.status !== "proposed") throw new Error("Patch not proposed");
    const run = s.runs.find(r => r.id === p.runId)!;
    const ancestors = recoveryChain(s, p), parent = ancestors[0];
    if (run.versionId !== p.baseVersionId || ["cancelled", "failed", "completed"].includes(run.status)) throw new Error("Patch base/run changed; compare and propose again");
    const next = s.versions.find(v => v.id === p.proposedVersionId);
    if (!next || !equal(patchImpact(versionFor(s, run), next, parent?.affectedNodeIds), p.affectedNodeIds)) throw new Error("Patch dependency impact is stale; compare source bindings and propose again");
    replacementBases(s, run, next, p.affectedNodeIds);
    const currentIds = s.attempts.filter(a => a.runId === run.id && p.affectedNodeIds.includes(a.nodeId) && current(s, run.id, a.nodeId)?.id === a.id).map(a => a.id);
    if (!equal(currentIds, p.affectedAttemptIds)) throw new Error("Affected attempts changed since proposal; inspect and propose again");
    if (s.corrections.some(x => x.runId === run.id && x.status === "waiting_boundary") || s.patches.some(x => x.runId === run.id && blocking(x) && !ancestors.includes(x))) throw new Error("Related change already awaits boundary/re-review");
    p.affectedAttemptIds = s.attempts.filter(a => a.runId === run.id && p.affectedNodeIds.includes(a.nodeId) && current(s, run.id, a.nodeId)?.id === a.id).map(a => a.id);
    preserveLegacyEscalation(s, run);
    p.escalationId = resolutionBasis(s, run, p.affectedAttemptIds);
    p.notificationIds = [];
    for (const a of s.attempts.filter(a => p.affectedAttemptIds!.includes(a.id))) {
      a.versionId ??= run.versionId;
      // Supersede applicability, never erase completed facts/evidence.
      a.supersededBy ??= `patch:${p.id}`;
      if (a.status !== "passed") a.status = "superseded";
    }
    for (const t of s.tasks.filter(t => p.affectedAttemptIds!.includes(t.attemptId))) {
      if (t.child) t.child.staleBy ??= `patch:${p.id}`;
      if (t.status !== "submitted" && !(t.child && t.child.completedAt)) t.status = "superseded";
      if (t.sessionId && !(t.child && t.child.completedAt) && !ancestors.some(old => old.affectedAttemptIds?.includes(t.attemptId))) {
        const id = enqueue(s, run.id, "workflow-patch", t.memberId, `User approved patch ${p.id}: ${p.reason}. Old work superseded; stop. Definition change is not a code rollback.`, {
          status: "undelivered", patchId: p.id, continuationAuthorized: false, error: `Not sent to original member: old authority revoked. Inspect/terminate task ${t.id}; separately recover pending native admissions. Replacement instructions are not predecessor notification.`,
        });
        p.notificationIds.push(id);
        audit(s, "patch.notification_undelivered", actor, `${p.id}: ${id} recipient=${t.memberId}; explicit user escalation retained`);
      }
    }
    for (const a of s.approvals) if (p.affectedAttemptIds.includes(a.attemptId) || p.affectedAttemptIds.includes(a.targetAttemptId)) a.valid = false;
    for (const d of s.deliveries) if (p.affectedAttemptIds.includes(d.attemptId)) d.staleBy ??= `patch:${p.id}`;
    p.status = "waiting_boundary"; p.approvedAt = now();
    return true;
  }
  return false;
}
export function patchBlocks(s: TeamflowSnapshot, runId: string, nodeId: string) {
  return s.patches.some(p => p.runId === runId && blocking(p) && p.affectedNodeIds.includes(nodeId));
}
function requireReview(s: TeamflowSnapshot, p: WorkflowPatch, reason: string, affectedNodeIds: string[]) {
  p.status = "review_required";
  p.reviewRequired = { reason, affectedNodeIds, detectedAt: now() };
  audit(s, "patch.review_required", { kind: "system" }, JSON.stringify({ patchId: p.id, reason, oldAffectedNodeIds: p.affectedNodeIds, requiredAffectedNodeIds: affectedNodeIds }));
}
export function settlePatches(s: TeamflowSnapshot, store: TeamflowStore) {
  for (const p of s.patches.filter(p => p.status === "waiting_boundary")) {
    const run = s.runs.find(r => r.id === p.runId);
    const base = s.versions.find(v => v.id === p.baseVersionId), next = s.versions.find(v => v.id === p.proposedVersionId);
    if (!run || !base || !next) { requireReview(s, p, "Approved run/base/target is missing; inspect history, no automatic reconstruction", p.affectedNodeIds); continue; }
    const ancestors = recoveryChain(s, p), parent = ancestors[0];
    const affected = patchImpact(base, next, parent?.affectedNodeIds);
    // Detect before native waiting: unsafe I/O is NOT permission to silently
    // expand the already-approved scope, nor to hide that re-review is required.
    if (!equal(affected, p.affectedNodeIds)) {
      requireReview(s, p, "Approved dependency scope is stale: source/graph closure changed. Original approval is retained but does not authorize the expanded scope; trusted user must inspect and re-propose, then approve separately.", affected);
      continue;
    }
    let bases: ReturnType<typeof replacementBases>;
    try { bases = replacementBases(s, run, next, p.affectedNodeIds); }
    catch (error) { requireReview(s, p, error instanceof Error ? error.message : "Effective source basis changed; user re-review required", affected); continue; }
    // A changed scoped attempt fence also needs fresh inspection, not a
    // permanent "native boundary" wait with no way to re-propose.
    if (p.affectedAttemptIds?.some(id => {
      const a = s.attempts.find(a => a.id === id);
      return !a || current(s, run.id, a.nodeId)?.id !== id || (a.supersededBy !== `patch:${p.id}` && !ancestors.some(old => old.affectedAttemptIds?.includes(id) && a.supersededBy === `patch:${old.id}`));
    })) {
      requireReview(s, p, "Approved attempt fence is stale: current affected attempts/applicability changed; inspect and re-propose without restoring old authority.", affected);
      continue;
    }
    const fencedIds = [...(p.affectedAttemptIds ?? []), ...ancestors.flatMap(old => old.affectedAttemptIds ?? [])];
    const tasks = s.tasks.filter(t => fencedIds.includes(t.attemptId));
    if (tasks.some(t => t.slotHeld || recoveryBlocks(t) || unresolvedIO(s, t) || store.pendingRequestForTask(s.scope, t.id))) continue;
    if (run.versionId !== p.baseVersionId || !["running", "waiting", "paused"].includes(run.status)) continue;
    // Pin ALL historical attempts before switching the run's current definition.
    for (const a of s.attempts.filter(a => a.runId === run.id)) a.versionId ??= run.versionId;
    p.replacementAttemptIds = [];
    for (const n of next.graph.nodes) {
      const old = current(s, run.id, n.id);
      if (old && !p.affectedNodeIds.includes(n.id)) continue;
      const basis = bases.get(n.id)!;
      const id = uid();
      s.attempts.push({
        id, runId: run.id, nodeId: n.id, versionId: next.id, round: (old?.round ?? 0) + 1, status: "pending",
        criteriaRevision: basis.criteriaRevision, requirements: basis.requirements,
        reworkCount: old ? automaticReturns(s, old) : 0, previousAttemptId: old?.id,
        reason: `User workflow patch ${p.id}; preserve effective correction basis; no code rollback`, createdAt: now(),
      });
      p.replacementAttemptIds.push(id);
    }
    run.versionId = next.id;
    p.status = "applied"; p.appliedAt = now();
    resolveEscalation(run, p.escalationId, "patch", p.id);
    for (const old of ancestors) old.status = "superseded"; // Old approval/history is never reactivated.
    audit(s, "patch.applied", { kind: "system" }, JSON.stringify({ patchId: p.id, runId: run.id, from: p.baseVersionId, to: next.id }));
  }
}
