import type { ActorContext, MutationEnvelope, MutationResult, CommandPayload } from "../../packages/protocol/src/index.js";
import { audit, uid } from "./engine.js";
import { backendProcessIdentity, existingRequestResult, requestProcessGone, writerKey } from "./dispatch.js";
import { bumpIO, conversationEligible, unresolvedIO } from "./execution-fence.js";
import type { TeamflowStore } from "./store.js";
import type { OpenCodeAdapter } from "./opencode-adapter.js";

/** Trusted evidence-driven reconciliation, not a retry. It uses the same unique
 * per-task request reservation as dispatch recovery, plus the same IO epoch. */
export async function reconcileMessage(d: {
  store: TeamflowStore; adapter: OpenCodeAdapter; envelope: MutationEnvelope;
  payload: CommandPayload<"message.reconcile">; actor: ActorContext; fingerprint: string;
}): Promise<MutationResult> {
  const { store, adapter, envelope: e, payload: p, actor, fingerprint } = d;
  if (actor.kind !== "user") throw new Error("Only trusted user may recover collaboration admission");
  const owner = `message-recovery:${uid()}`;
  const initial = store.transact(e.scope, s => {
    const prior = existingRequestResult(store, s, e.requestId, fingerprint);
    if (prior) return { prior };
    if (s.revision !== e.expectedRevision) throw new Error(`Revision conflict: expected ${e.expectedRevision}, current ${s.revision}; refresh snapshot`);
    const m = s.messages.find(m => m.id === p.messageId);
    const t = m && s.tasks.find(t => t.memberId === m.to && t.runId === m.runId);
    if (!m || !t?.sessionId) throw new Error("Need registered message recipient/session");
    if (p.action === "terminate" && m.status === "undelivered" && (m.correctionId || m.patchId)) throw new Error(
      `Change ${m.correctionId ?? m.patchId} was never sent; its undelivered escalation cannot be terminated as a native message. Use dispatch.reconcile inspect/terminate for original task ${t.id}. Recover any actual pending message by its own ID; the original-member notification remains undelivered.`);
    if (p.action === "adopt") {
      if (m.status !== "intent" || m.request || m.admission || !conversationEligible(s, t)) throw new Error("Adopt only a never-issued, still-applicable legacy intent; never retry unknown admission");
      if (store.pendingRequestForTask(e.scope, t.id)) throw new Error("Recipient recovery is in progress; finish it first");
      m.continuationAuthorized = true; bumpIO(t); s.revision++;
      audit(s, "message.legacy_intent_authorized", actor, `${m.id}: ${p.reason}`);
      const result = { revision: s.revision, snapshot: structuredClone(s) };
      store.saveRequest(e.scope, e.requestId, fingerprint, result); return { prior: result };
    }
    if (p.action === "terminate" && m.status === "acknowledged") throw new Error("Handled acknowledgement is historical; cannot cancel it");
    const pending = store.pendingRequestForTask(e.scope, t.id);
    if (pending && !requestProcessGone(pending.process)) return { prior: { revision: s.revision, snapshot: structuredClone(s), inProgress: { requestId: pending.requestId, taskId: t.id, reason: "task_reconciliation_in_progress" as const } } };
    if (pending) {
      if (t.reconciliation?.requestId === pending.requestId) t.reconciliation.state = "blocked";
      if (t.messageRecovery?.requestId === pending.requestId) t.messageRecovery.state = "blocked";
      if (t.messageInspection?.requestId === pending.requestId) t.messageInspection.state = "blocked";
      store.saveRequest(e.scope, pending.requestId, pending.fingerprint, { revision: s.revision, snapshot: structuredClone(s) }, pending.token);
    }
    store.reserveRequest(e.scope, e.requestId, fingerprint, owner, backendProcessIdentity, t.id);
    // The reservation fences concurrent issuers; an observation must not take
    // execution ownership away from a scheduler that is binding this session.
    if (p.action === "terminate") t.owner = owner;
    bumpIO(t);
    // Observation results must not erase an unresolved terminate's block.
    const record = { requestId: e.requestId, messageId: m.id, state: "checking" as const, evidence: [] };
    if (p.action === "inspect") t.messageInspection = record;
    else t.messageRecovery = record;
    s.revision++; audit(s, "message.recovery_intent", actor, `${m.id}: ${p.action}; ${p.reason}`);
    return { task: structuredClone(t), message: structuredClone(m) };
  });
  if (initial.prior) return initial.prior;
  const { task, message } = initial;
  const evidence: string[] = [];
  let state: "observed" | "terminated" | "blocked" = "blocked";
  let found: "queued" | "delivered" | "absent" = "absent";
  let proved = false, cancelled = false, nativeSafe = false;
  try {
    const n = await adapter.inspectCollaboration(e.scope, task!, message!);
    found = n.message; evidence.push(...n.evidence);
    const neverIssued = !message!.request && !message!.admission && ["intent", "undelivered"].includes(message!.status);
    const processGone = requestProcessGone(message!.request?.process);
    proved = found !== "absent" || neverIssued || message!.request?.state === "not_sent" || message!.request?.state === "settled" ||
      ["accepted", "observed_inbox", "observed_context"].includes(message!.admission ?? "") || processGone;
    evidence.push(`single-call admission proof=${proved}; never issued=${neverIssued}; original process gone=${processGone}; request=${message!.request?.state ?? "legacy"}`);
    if (!proved) throw new Error("Absent ID does not fence a live unresolved native call. Retain slot/writer; wait for exact matching receipt or verifiable issuer process end, never resend.");
    if (p.action === "inspect") state = "observed";
    else {
      if (found === "queued") {
        const ids = await adapter.cancelQueuedCollaboration(task!.sessionId!, [message!.id]);
        cancelled = ids.includes(message!.id);
        if (!cancelled) throw new Error("Queue changed during cancellation; inspect again, do not infer cancellation");
      } else cancelled = true; // no queued target; historical delivered fact retained in admission field
      await adapter.interrupt(task!.sessionId!);
      const after = await adapter.inspectCollaboration(e.scope, task!, message!);
      evidence.push(...after.evidence);
      nativeSafe = after.exists && !after.busy && after.inboxIds.length === 0;
      if (!nativeSafe) throw new Error("Native tools/shells/execution/other inbox still active; no execution lease release");
      state = "terminated";
    }
  } catch (error) { evidence.push(error instanceof Error ? error.message : "Native recovery unavailable"); }
  return store.transact(e.scope, s => {
    const t = s.tasks.find(t => t.id === task!.id)!, m = s.messages.find(m => m.id === message!.id)!;
    const record = p.action === "inspect" ? t.messageInspection : t.messageRecovery;
    if (record?.requestId !== e.requestId) throw new Error("Message recovery fenced; no release");
    const unchanged = t.owner === task!.owner && (t.ioEpoch ?? 0) === (task!.ioEpoch ?? 0) && m.request?.token === message!.request?.token;
    // Receipt/queue cancellation are facts even if a concurrent callback makes
    // the final release observation stale. Never turn cancelled back into ack.
    if (proved && m.request?.token === message!.request?.token) {
      // Process-death/receipt fencing proves no future admission, not that the
      // message was historically never admitted. Preserve admission separately;
      // reserve not_sent for an actual pre-invocation DispatchNotSent proof.
      if (m.request && m.request.state !== "not_sent") m.request.state = "settled";
      if (found !== "absent" && m.admission !== "observed_context") m.admission = found === "queued" ? "observed_inbox" : "observed_context";
      if (m.status !== "cancelled" && m.status !== "acknowledged") {
        if (p.action === "terminate" && cancelled) m.status = "cancelled";
        else if (found !== "absent") m.status = "delivered";
        // inspect + absent is observation only, not cancellation. In particular
        // an unsent intent must remain eligible for explicit legacy adoption.
      }
    } else if (cancelled && m.status !== "acknowledged") m.status = "cancelled";
    if (!unchanged || state === "terminated" && (unresolvedIO(s, t) || t.reconciliation?.state === "checking")) {
      state = "blocked"; evidence.push("IO epoch changed or another native admission/recovery is unresolved; retain execution/writer lease");
    }
    if (state === "terminated" && nativeSafe) {
      if (t.reconciliation?.state === "blocked") { t.reconciliation.state = "terminated"; t.reconciliation.evidence.push("Subsequent trusted message termination proved all admissions settled and native execution empty"); }
      t.slotHeld = false;
      if (t.writes) store.release(writerKey(e.scope), t.id);
      if (["running", "bound", "uncertain"].includes(t.status) && t.executionMode !== "conversation") {
        t.status = "cancelled";
        const a = s.attempts.find(a => a.id === t.attemptId)!;
        if (!t.child && a.status === "running") { a.status = "failed"; a.reason = `User terminated message/execution: ${p.reason}`; }
      }
    }
    if (p.action === "inspect") t.messageInspection!.state = state === "blocked" ? "blocked" : "observed";
    else t.messageRecovery!.state = state;
    record.evidence = evidence; bumpIO(t);
    s.revision++; audit(s, "message.reconciled", actor, JSON.stringify({ messageId: m.id, action: p.action, state, evidence }));
    const result = { revision: s.revision, snapshot: structuredClone(s) };
    store.saveRequest(e.scope, e.requestId, fingerprint, result, owner); return result;
  });
}
