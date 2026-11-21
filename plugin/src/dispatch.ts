import { readFileSync, realpathSync } from "node:fs";
import type { ActorContext, BackendScope, CommandPayload, MutationEnvelope, MutationResult, Task, TeamflowSnapshot } from "../../packages/protocol/src/index.js";
import type { OpenCodeAdapter } from "./opencode-adapter.js";
import type { TeamflowStore } from "./store.js";
import { advance, audit, attemptVersion, current, uid } from "./engine.js";
import { bumpIO, unresolvedMessages } from "./execution-fence.js";

export const writerKey = (scope: BackendScope) => `writer:${scope.backendId}:${realpathSync(scope.projectDirectory)}`;
export const leaderKey = (scope: BackendScope) => `scheduler:${scope.backendId}:${scope.projectDirectory}`;
// Native requests run in this backend process. PID reuse must not imply liveness.
const processIdentity = (pid: number) => {
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
  return `${readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()}:${pid}:${stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]}`;
};
export const backendProcessIdentity = processIdentity(process.pid)!;
export function requestProcessGone(identity: string | undefined) {
  if (!identity) return false; // Legacy requests have no proof of process death.
  const pid = Number(identity.split(":")[1]);
  try { return Number.isInteger(pid) && processIdentity(pid) !== identity; }
  catch { return false; } // An unreadable /proc is NOT proof of process death.
}
export function bindNativeSession(s: TeamflowSnapshot, task: Task, sessionId: string) {
  if (task.sessionId && task.sessionId !== sessionId) throw new Error("Dispatch returned a different session");
  task.sessionId = sessionId;
  const old = s.members.find(m => m.id === task.memberId);
  if (old && old.sessionId !== sessionId) throw new Error("Member already bound to a different session");
  if (!old) {
    const attempt = s.attempts.find(a => a.id === task.attemptId)!;
    const node = attemptVersion(s, attempt).graph.nodes.find(n => n.id === attempt.nodeId)!;
    s.members.push({ id: task.memberId, runId: task.runId, role: task.child?.role ?? node.role!, sessionId, taskId: task.id, ...(task.child ? { parentMemberId: task.child.parentMemberId } : {}) });
  }
}
export function existingRequestResult(store: TeamflowStore, s: TeamflowSnapshot, requestId: string, fingerprint: string): MutationResult | undefined {
  const prior = store.request(s.scope, requestId);
  if (prior) {
    if (prior.fingerprint !== fingerprint) throw new Error("requestId already used with different command/identity");
    return prior.state === "completed" ? prior.result : {
      revision: s.revision, snapshot: structuredClone(s),
      inProgress: { requestId, taskId: prior.taskId, reason: "request_in_progress" },
    };
  }
  // A hot-reloaded pre-reservation handler may still be running. Its fingerprint
  // is unavailable, so do not allow another command to claim that legacy ID.
  if (s.tasks.some(t => t.reconciliation?.state === "checking" && t.reconciliation.requestId === requestId || t.inspection?.state === "checking" && t.inspection.requestId === requestId)) throw new Error("Legacy request still in progress; fingerprint unavailable; do not reuse its requestId");
}

/** Explicit trusted-user reconciliation. Native observations, not user checkboxes,
 * decide whether to bind an existing execution or release its writer ownership. */
export async function reconcileDispatch(deps: {
  store: TeamflowStore; adapter: OpenCodeAdapter; envelope: MutationEnvelope;
  payload: CommandPayload<"dispatch.reconcile">; actor: ActorContext; fingerprint: string;
}): Promise<MutationResult> {
  const { store, adapter, envelope, payload: p, actor, fingerprint } = deps;
  if (actor.kind !== "user") throw new Error("Forbidden: dispatch reconciliation requires trusted user");
  const owner = `reconcile:${uid()}`;
  const initial = store.transact(envelope.scope, s => {
    const prior = existingRequestResult(store, s, envelope.requestId, fingerprint);
    if (prior) return { prior };
    if (s.revision !== envelope.expectedRevision) throw new Error(`Revision conflict: expected ${envelope.expectedRevision}, current ${s.revision}; refresh snapshot`);
    const t = s.tasks.find(t => t.id === p.taskId);
    if (!t) throw new Error("Unknown dispatch task");
    const active = store.pendingRequestForTask(envelope.scope, t.id);
    if (active && requestProcessGone(active.process)) {
      // No timeout takeover: only proof that the actual backend process ended.
      // This ends bookkeeping, NEVER releases a writer or skips native rechecks.
      const evidence = `Recovery backend process ended: ${active.process}; new user reconciliation must recheck native state`;
      if (t.reconciliation?.requestId === active.requestId) { t.reconciliation.state = "blocked"; t.reconciliation.evidence.push(evidence); }
      if (t.inspection?.requestId === active.requestId) { t.inspection.state = "blocked"; t.inspection.evidence.push(evidence); }
      if (t.messageInspection?.requestId === active.requestId) { t.messageInspection.state = "blocked"; t.messageInspection.evidence.push(evidence); }
      if (t.messageRecovery?.requestId === active.requestId) { t.messageRecovery.state = "blocked"; t.messageRecovery.evidence.push(evidence); }
      s.revision++; audit(s, "dispatch.recovery_process_ended", actor, JSON.stringify({ taskId: t.id, requestId: active.requestId, evidence }));
      store.saveRequest(envelope.scope, active.requestId, active.fingerprint, { revision: s.revision, snapshot: structuredClone(s) }, active.token);
    } else if (active) {
      return { prior: { revision: s.revision, snapshot: structuredClone(s), inProgress: { requestId: active.requestId, taskId: t.id, reason: "task_reconciliation_in_progress" as const } } };
    }
    const legacy = t.reconciliation?.state === "checking" ? t.reconciliation : t.inspection?.state === "checking" ? t.inspection : undefined;
    if (legacy) return { prior: { revision: s.revision, snapshot: structuredClone(s), inProgress: { requestId: legacy.requestId, taskId: t.id, reason: "task_reconciliation_in_progress" as const } } };
    if (p.action !== "inspect") {
      if (!t.slotHeld) throw new Error("Dispatch no longer holds an execution/writer lease");
    }
    // The unique scope/task reservation is held through ALL native side effects
    // and the final transaction. Other locations cannot replace this owner.
    store.reserveRequest(envelope.scope, envelope.requestId, fingerprint, owner, backendProcessIdentity, t.id);
    if (p.action !== "inspect") {
      t.owner = owner; // Fence old creators/deliverers BEFORE any asynchronous probe.
      bumpIO(t);
      if (!t.dispatch) t.legacyFenceProcess ??= backendProcessIdentity;
      if (!["cancelled", "superseded", "submitted"].includes(t.status)) t.status = "uncertain";
    }
    if (p.action === "inspect") t.inspection = { requestId: envelope.requestId, state: "checking", evidence: [] };
    else t.reconciliation = { requestId: envelope.requestId, action: p.action, state: "checking", reason: p.reason, evidence: [] };
    audit(s, "dispatch.reconcile_intent", actor, JSON.stringify({ taskId: t.id, action: p.action, reason: p.reason, fence: p.action === "inspect" ? "read-only" : owner }));
    s.revision++;
    return { task: structuredClone(t) };
  });
  if (initial.prior) return initial.prior;
  let task = initial.task!;
  const observedEpoch = task.ioEpoch ?? 0;
  let state: NonNullable<Task["reconciliation"]>["state"] = "blocked";
  const evidence: string[] = [];
  let sessionId: string | undefined;
  try {
    let observation = await adapter.inspectDispatch(envelope.scope, task, p.sessionId);
    sessionId = observation.exists ? observation.sessionId : undefined;
    evidence.push(...observation.evidence);
    const fresh = store.read(envelope.scope).tasks.find(t => t.id === task.id)!;
    if (p.action !== "inspect" && fresh.owner !== owner) throw new Error("Reconciliation superseded by another fence; refresh snapshot");
    task = fresh;
    const processGone = requestProcessGone(task.dispatch?.process ?? task.legacyFenceProcess);
    const deliveryPending = task.dispatch?.delivery === "pending" && !processGone;
    evidence.push(`durable create=${task.dispatch?.create ?? "legacy/untracked"} delivery=${task.dispatch?.delivery ?? "legacy/untracked"}; creation in flight=${task.dispatch?.create === "pending"}; admission in flight=${deliveryPending}; processGone=${processGone}`);
    if (p.action === "inspect") {
      state = "ready"; // Only an observation, never a scheduling authorization.
    } else if (p.action === "bind") {
      const snapshot = store.read(envelope.scope), run = snapshot.runs.find(r => r.id === task.runId)!;
      const a = snapshot.attempts.find(a => a.id === task.attemptId)!;
      if (["cancelled", "failed", "completed"].includes(run.status) || current(snapshot, run.id, a.nodeId)?.id !== a.id || ["superseded", "cancelled", "failed", "needs_revision"].includes(a.status)) throw new Error("Cannot bind a terminal/superseded attempt; choose terminate");
      if (!observation.exists) throw new Error("Actual native session not found; binding cannot create or resend");
      if (observation.message !== "absent") {
        state = "bound"; // Adopt the already-admitted ID. NEVER send it again.
      } else {
        if (deliveryPending || task.dispatch?.delivery === "failed" || task.dispatch?.delivery === "admitted") throw new Error("Unconfirmed/previous admission cannot be resent; need native matching dispatch or settled no-send evidence");
        if (!task.dispatch?.brief || !["not_started", "not_sent"].includes(task.dispatch.delivery)) throw new Error("No durable unissued delivery/brief; legacy unknown admission needs further evidence");
        if (observation.busy || observation.inboxIds.length) throw new Error("Native session already busy/queued without this dispatch; cannot bind as unstarted");
        await adapter.prepareBound(observation.sessionId, task.dispatch.brief, task.dispatch.modelPlan?.model);
        state = "ready"; // Scheduler may issue the original never-sent intent once.
      }
    } else {
      // A create-only request cannot start a model. Its late result is still
      // recorded, but the fenced creator can never authorize synthetic delivery.
      const noDeliveryStarted = task.dispatch && ["not_started", "not_sent"].includes(task.dispatch.delivery);
      if (deliveryPending && observation.message === "absent") throw new Error("Native admission request is still in flight and no matching receipt exists; wait for durable/native receipt or verified original process end");
      if (!noDeliveryStarted && observation.message === "absent" && !processGone) throw new Error("Native dispatch absent but admission outcome unproved; retain lease until matching native receipt or verified fenced backend process death (legacy fence recorded)");
      observation = await adapter.stopDispatch(envelope.scope, task, p.sessionId);
      evidence.push(...observation.evidence);
      if (observation.busy || observation.inboxIds.length) throw new Error("Native executor is still busy or has queued inputs; keep lease and inspect again");
      if (!observation.exists && !noDeliveryStarted && !processGone) throw new Error("Missing native session alone does not prove an unknown admission harmless");
      state = "terminated";
      if (noDeliveryStarted) evidence.push("Writer release proof: delivery was never issued; old owner is durably fenced. Any late fresh-session creation can only be recorded, never started.");
    }
  } catch (error) {
    evidence.push(error instanceof Error ? error.message || error.name : "Native reconciliation unavailable");
    state = "blocked";
  }
  return store.transact(envelope.scope, s => {
    const t = s.tasks.find(t => t.id === p.taskId)!;
    if (p.action === "inspect") {
      if (t.inspection?.requestId !== envelope.requestId) throw new Error("Inspection superseded; refresh snapshot");
      t.inspection.state = state === "blocked" ? "blocked" : "observed"; t.inspection.evidence = evidence;
      s.revision++; audit(s, "dispatch.inspected", actor, JSON.stringify({ taskId: t.id, state, evidence }));
      const result = { revision: s.revision, snapshot: structuredClone(s) };
      store.saveRequest(envelope.scope, envelope.requestId, fingerprint, result, owner);
      return result;
    }
    if (t.reconciliation?.requestId !== envelope.requestId || t.owner !== owner) throw new Error("Reconciliation was fenced; no ownership released");
    if ((t.ioEpoch ?? 0) !== observedEpoch || unresolvedMessages(s, t) ||
      t.messageRecovery?.state === "checking" || t.messageInspection?.state === "checking") {
      state = "blocked";
      evidence.push("Shared admission fence changed or collaboration call/recovery unresolved; no release/bind. Recover messages then inspect again.");
    }
    t.reconciliation.state = state; t.reconciliation.evidence = evidence;
    if (p.action === "bind" && state !== "blocked") {
      const run = s.runs.find(r => r.id === t.runId)!;
      const a = s.attempts.find(a => a.id === t.attemptId)!;
      if (["cancelled", "completed", "failed"].includes(run.status) || current(s, run.id, a.nodeId)?.id !== a.id || ["cancelled", "superseded", "failed", "needs_revision"].includes(a.status)) {
        state = "blocked"; t.reconciliation.state = state;
        evidence.push("Run/attempt changed during native reconciliation; binding refused");
      }
    }
    if (sessionId) bindNativeSession(s, t, sessionId);
    if (state === "terminated") {
      if (t.dispatch && ["pending", "failed"].includes(t.dispatch.delivery)) t.dispatch.delivery = "terminated"; // fenced, not fabricated admission
      if (!(t.child && t.status === "submitted")) t.status = "cancelled";
      if (t.messageRecovery?.state === "blocked") { t.messageRecovery.state = "terminated"; t.messageRecovery.evidence.push("Subsequent trusted dispatch termination proved no unresolved admissions and native safety"); }
      t.slotHeld = false; delete t.error;
      bumpIO(t);
      if (t.writes) store.release(writerKey(envelope.scope), t.id);
      const a = s.attempts.find(a => a.id === t.attemptId)!;
      if (!t.child && a.status === "running") { a.status = "failed"; a.reason = `User terminated dispatch after native reconciliation: ${p.reason}`; }
    } else if (p.action === "bind" && state !== "blocked") {
      t.status = state === "bound" ? "running" : "bound";
      delete t.error;
    } else if (state === "blocked") t.error = evidence.at(-1);
    advance(s); s.revision++;
    audit(s, "dispatch.reconciled", actor, JSON.stringify({ taskId: t.id, action: p.action, state, evidence }));
    const result = { revision: s.revision, snapshot: structuredClone(s) };
    store.saveRequest(envelope.scope, envelope.requestId, fingerprint, result, owner);
    return result;
  });
}
