import { randomUUID } from "node:crypto";
import type { Run, TeamflowSnapshot } from "../../packages/protocol/src/index.js";

export const activeEscalation = (run: Run) => {
  const latest = run.escalations?.at(-1);
  return latest && !latest.resumedAt ? latest : undefined;
};
export function escalate(run: Run, reason: string, affectedAttemptIds: string[]) {
  const previous = activeEscalation(run);
  // Other already-admitted members can still veto while scheduling is paused.
  // A newer escalation must not hide an older unresolved branch's basis.
  const outstanding = previous && !previous.resolution ? previous.affectedAttemptIds : [];
  (run.escalations ??= []).push({ id: randomUUID(), reason, createdAt: new Date().toISOString(), versionId: run.versionId,
    affectedAttemptIds: [...new Set([...outstanding, ...affectedAttemptIds])] });
  run.status = "paused"; run.waitingReason = reason;
}
/** Old snapshots have no trustworthy affected basis. A NEW user-approved change
 * covering all current non-end attempts is the explicit conservative recovery path. */
export function preserveLegacyEscalation(s: TeamflowSnapshot, run: Run) {
  if (activeEscalation(run) || !run.waitingReason?.startsWith("Escalation:")) return;
  const nodes = s.versions.find(v => v.id === run.versionId)!.graph.nodes.filter(n => n.kind !== "end");
  const ids = nodes.flatMap(n => {
    const a = s.attempts.filter(a => a.runId === run.id && a.nodeId === n.id).sort((a, b) => b.round - a.round)[0];
    return a ? [a.id] : [];
  });
  escalate(run, run.waitingReason, ids);
  activeEscalation(run)!.legacy = true;
}
/** Called only at trusted correction.apply / patch.apply, never at proposal time. */
export function resolutionBasis(s: TeamflowSnapshot, run: Run, affectedAttemptIds: string[]) {
  const e = activeEscalation(run);
  // Keep the original attempts as historical evidence, but compare node coverage:
  // an unrelated downstream correction may already have replaced one of them.
  // Requiring its obsolete ID would make a later relevant correction impossible.
  const nodes = new Set(s.attempts.filter(a => a.runId === run.id && affectedAttemptIds.includes(a.id)).map(a => a.nodeId));
  return e && !e.resolution && e.affectedAttemptIds.length &&
    e.affectedAttemptIds.every(id => {
      const a = s.attempts.find(a => a.id === id && a.runId === run.id);
      return a && nodes.has(a.nodeId);
    }) ? e.id : undefined;
}
/** Only the matching, fully applied change may resolve this exact escalation.
 * Resolution is evidence, NOT permission to resume scheduling automatically. */
export function resolveEscalation(run: Run, escalationId: string | undefined, kind: "correction" | "patch", id: string) {
  const e = activeEscalation(run);
  if (!e || e.id !== escalationId || e.resolution) return;
  e.resolution = { kind, id, appliedAt: new Date().toISOString() };
}
