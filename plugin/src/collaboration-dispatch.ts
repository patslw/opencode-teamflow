import type { BackendScope, TeamflowSnapshot, TeamflowMessage } from "../../packages/protocol/src/index.js";
import { advance, audit, uid } from "./engine.js";
import { backendProcessIdentity, writerKey } from "./dispatch.js";
import { bumpIO, conversationEligible, recoveryBlocks } from "./execution-fence.js";
import { messageMayDeliver } from "./topic-policy.js";
import { DispatchNotSentError, type OpenCodeAdapter } from "./opencode-adapter.js";
import type { TeamflowStore } from "./store.js";
import { blockingQuestion } from "./questions.js";

export function senderLabel(s: TeamflowSnapshot, m: TeamflowMessage) {
  const kind = m.senderKind ?? (s.members.some(x => x.id === m.from) ? "agent" : ["user", "user-correction"].includes(m.from) ? "user" : "system");
  return `${kind === "user" ? "trusted user" : kind === "agent" ? "agent member" : "system"} ${m.from} (not Gate approval)`;
}
export async function pumpCollaboration(d: {
  store: TeamflowStore; adapter: OpenCodeAdapter; scope: BackendScope; owner: string;
  leader(): boolean; announce(s: TeamflowSnapshot): Promise<void>;
}) {
  const { store, adapter, scope } = d;
  const snapshot = store.read(scope);
  const answerIds = new Set(snapshot.questions.filter(q => q.status === "answered").map(q => q.answerMessageId));
  for (const original of snapshot.messages) {
    if (!d.leader()) return;
    if (original.request && ["in_flight", "unknown"].includes(original.request.state) || original.admission === "pending") {
      const s = store.read(scope), task = s.tasks.find(t => t.memberId === original.to && t.runId === original.runId);
      if (!task?.sessionId) continue;
      try {
        const native = await adapter.inspectCollaboration(scope, task, original);
        if (native.message === "absent") continue; // absence never proves no late admission
        const updated = store.transact(scope, s => {
          const m = s.messages.find(m => m.id === original.id)!;
          if (m.request?.token !== original.request?.token) return;
          if (m.request) m.request.state = "settled"; // native matching ID proves the single call already admitted
          m.admission = native.message === "queued" ? "observed_inbox" : "observed_context";
          if (!["cancelled", "acknowledged"].includes(m.status)) m.status = "delivered";
          bumpIO(s.tasks.find(t => t.id === task.id)!); advance(s); s.revision++;
          audit(s, "message.native_observed", { kind: "system" }, m.id);
          return structuredClone(s);
        });
        if (updated) await d.announce(updated);
      } catch { /* unknown remains pinned and can be explicitly recovered */ }
      continue;
    }
    // Accepted is a durable native receipt. Observe for display/ack separately.
    if (original.status === "delivered" && original.admission === "accepted" ||
      answerIds.has(original.id) && ["delivered", "acknowledged"].includes(original.status) && original.admission === "observed_inbox") {
      try {
        const s = store.read(scope), t = s.tasks.find(t => t.memberId === original.to && t.runId === original.runId);
        if (!t?.sessionId) continue;
        const n = await adapter.inspectCollaboration(scope, t, original);
        if (n.message === "absent") continue;
        const updated = store.transact(scope, s => {
          const m = s.messages.find(m => m.id === original.id)!;
          if (!["delivered", "acknowledged"].includes(m.status) || m.admission === "observed_context") return;
          const admission = n.message === "queued" ? "observed_inbox" : "observed_context";
          if (m.admission === admission) return;
          const freshTask = s.tasks.find(task => task.id === t.id && task.memberId === m.to && task.runId === m.runId);
          if (!freshTask) return;
          m.admission = admission; bumpIO(freshTask); advance(s); s.revision++;
          return structuredClone(s);
        });
        if (updated) await d.announce(updated);
      } catch { /* do not resend */ }
      continue;
    }
    const authorized = store.transact(scope, s => {
      if (!d.leader()) return;
      const m = s.messages.find(m => m.id === original.id)!;
      if (m.status !== "intent" || m.request) return;
      // Pre-fix intents were explicitly non-waking. A hot reload must not turn
      // those old records into permission to resume another location's sessions.
      if (!m.continuationAuthorized) return;
      const t = s.tasks.find(t => t.memberId === m.to && t.runId === m.runId);
      if (!t?.sessionId) return;
      if (!conversationEligible(s, t)) {
        if (["superseded", "cancelled"].includes(t.status) || t.child?.staleBy ||
          ["cancelled", "failed"].includes(s.runs.find(r => r.id === t.runId)!.status) ||
          ["failed", "cancelled", "superseded", "needs_revision"].includes(s.attempts.find(a => a.id === t.attemptId)!.status)) {
          m.status = "cancelled"; m.error = "Recipient execution is cancelled/superseded/stale; never revive it"; s.revision++;
        }
        return;
      }
      if (!messageMayDeliver(s, m)) {
        const topic = s.topics.find(x => x.id === m.topicId);
        if (topic && (topic.status !== "open" || m.topicStage === "question" && topic.round !== 1)) {
          m.status = "cancelled"; m.error = "Topic phase closed/escalated before admission; no discussion route reopening"; s.revision++;
        }
        return;
      }
      if (recoveryBlocks(t) || store.pendingRequestForTask(scope, t.id)) return;
      const run = s.runs.find(r => r.id === t.runId)!;
      const q = blockingQuestion(s, t);
      // Wait for the original native turn's safe idle boundary before resuming
      // it. Peer DMs cannot bypass a question or consume its reply's slot.
      const answering = q?.status === "answered" && q.answerMessageId === m.id && q.memberId === t.memberId && q.taskId === t.id && m.taskId === t.id;
      if (q && (!answering || t.slotHeld)) return;
      if (t.status === "submitted") t.executionMode = "conversation";
      if (!t.slotHeld) {
        if (s.tasks.filter(x => x.runId === t.runId && x.slotHeld).length >= run.config.activeSlots) return;
        if (t.writes && !store.acquire(writerKey(scope), t.id)) return;
        t.slotHeld = true; t.executionMode = answering ? "workflow" : "conversation";
      }
      if (t.writes && !store.owns(writerKey(scope), t.id)) throw new Error("Writer execution slot lost its directory lease; recover before continuation");
      t.owner = d.owner;
      const text = `${m.text}\nMessage ID: ${m.id}. Handle then acknowledge via message.ack after native observation.
${t.executionMode === "conversation" || t.status === "submitted" ? "SCHEDULER-ADMITTED SAME-SESSION CONVERSATION. The workflow task is already submitted. Do not edit artifacts, resubmit work or a professional pass, spawn workflow work, or treat this as Gate approval. ONLY the original professional reviewer/tester may use review.submit needs_revision/reject to veto its still-current prior pass, with the EXACT original attempt/target/delivery/artifact/criteria binding and actual new issues. This is the narrow exception to earlier no-resubmission instructions, NOT permission to repeat a pass or old work. Superseded bindings and self-review remain forbidden. Reply in this session; acknowledge this actual message. Use topic.respond only for its open topic; topic communications consume that topic's round budget." : "Continue only the current assigned task; discussion is not approval."}`;
      m.request = { token: uid(), process: backendProcessIdentity, state: "in_flight", text, source: senderLabel(s, m) };
      m.status = "uncertain"; m.admission = "pending"; bumpIO(t); s.revision++;
      audit(s, "message.admission_intent", { kind: "system" }, `${m.id} task=${t.id} epoch=${t.ioEpoch} mode=${t.executionMode ?? "workflow"}`);
      return { taskId: t.id, sessionId: t.sessionId, message: structuredClone(m), snapshot: structuredClone(s) };
    });
    if (!authorized) continue;
    const m = authorized.message;
    // The authorizing transaction is adjacent to this ONE native call: no await.
    const admission = adapter.deliver({ messageId: m.id, sessionId: authorized.sessionId, source: m.request!.source, text: m.request!.text, intent: "queue", resume: true });
    const settle = async (error?: unknown) => {
      const snapshot = store.transact(scope, s => {
        const fresh = s.messages.find(x => x.id === m.id)!;
        if (fresh.request?.token !== m.request!.token) return;
        // A late failure cannot erase stronger native evidence or cancellation.
        if (fresh.request.state !== "settled") fresh.request.state = error ? error instanceof DispatchNotSentError ? "not_sent" : "unknown" : "settled";
        if (error) fresh.error = error instanceof Error ? error.message : "Unknown native admission";
        if (!error && !["acknowledged", "cancelled"].includes(fresh.status)) fresh.status = "delivered";
        if (!error && fresh.admission === "pending") fresh.admission = "accepted";
        if (fresh.request.state === "not_sent") fresh.status = "cancelled";
        bumpIO(s.tasks.find(t => t.id === authorized.taskId)!); s.revision++;
        audit(s, "message.receipt", { kind: "system" }, `${m.id}: ${fresh.request.state}`);
        return structuredClone(s);
      });
      if (snapshot) await d.announce(snapshot);
    };
    void admission.then(() => settle(), error => settle(error)).catch(error => console.error("Teamflow message receipt:", error));
    await d.announce(authorized.snapshot);
  }
}
