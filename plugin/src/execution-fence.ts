import type { Task, TeamflowSnapshot } from "../../packages/protocol/src/index.js";

/** One monotonic fence per native session/task, shared by every issuer and releaser.
 * Capture BEFORE native observations, compare in the final SQLite transaction.
 * A successful native receipt means durable admission, NOT execution completion.
 * Unresolved calls pin the slot even if a native observation currently says idle. */
export function bumpIO(t: Task) { t.ioEpoch = (t.ioEpoch ?? 0) + 1; }
export function recoveryBlocks(t: Task) {
  return !!(t.reconciliation && ["checking", "blocked"].includes(t.reconciliation.state) ||
    t.messageRecovery && ["checking", "blocked"].includes(t.messageRecovery.state) ||
    t.messageInspection?.state === "checking");
}
export function unresolvedIO(s: TeamflowSnapshot, t: Task) {
  return !!(t.dispatch && ["pending", "failed"].includes(t.dispatch.delivery) ||
    !t.dispatch && s.audit.some(e => e.type === "dispatch.delivery_intent" && e.detail === t.dispatchId) &&
      !s.audit.some(e => e.type === "dispatch.admitted" && e.detail === t.dispatchId) ||
    unresolvedMessages(s, t));
}
export function unresolvedMessages(s: TeamflowSnapshot, t: Task) {
  return s.messages.some(m => m.to === t.memberId && m.runId === t.runId &&
    (m.request ? ["in_flight", "unknown"].includes(m.request.state) : m.admission === "pending" || m.status === "uncertain"));
}
export function conversationEligible(s: TeamflowSnapshot, t: Task, allowPausedReceipt = false) {
  const run = s.runs.find(r => r.id === t.runId);
  const a = s.attempts.find(a => a.id === t.attemptId);
  if (!run || ["cancelled", "failed"].includes(run.status) || (run.status === "paused" && !allowPausedReceipt) || !a || a.supersededBy ||
    !["running", "passed"].includes(a.status) || t.child?.staleBy ||
    !["running", "submitted"].includes(t.status)) return false;
  const latest = s.attempts.filter(x => x.runId === t.runId && x.nodeId === a.nodeId).sort((a, b) => b.round - a.round)[0];
  return latest?.id === a.id;
}
export function mayRelease(s: TeamflowSnapshot, observed: Task, fresh: Task) {
  return fresh.slotHeld && fresh.owner === observed.owner &&
    (fresh.ioEpoch ?? 0) === (observed.ioEpoch ?? 0) &&
    !recoveryBlocks(fresh) && !unresolvedIO(s, fresh);
}
