import type { BackendScope, TeamflowSnapshot } from "../../packages/protocol/src/index.js";
import { advance, audit } from "./engine.js";
import { writerKey } from "./dispatch.js";
import { bumpIO, mayRelease, recoveryBlocks, unresolvedIO } from "./execution-fence.js";
import type { OpenCodeAdapter } from "./opencode-adapter.js";
import type { TeamflowStore } from "./store.js";
import { blockingQuestion } from "./questions.js";

export async function reconcileExecutions(d: {
  store: TeamflowStore; adapter: OpenCodeAdapter; scope: BackendScope; owner: string;
  leader(): boolean; announce(s: TeamflowSnapshot): Promise<void>;
}) {
  const { store, adapter, scope } = d;
  for (const initial of store.read(scope).tasks.filter(t => t.slotHeld)) {
    if (!d.leader()) return;
    let observed = store.read(scope).tasks.find(t => t.id === initial.id)!;
    if (recoveryBlocks(observed)) continue;
    if (observed.owner !== d.owner && !observed.child?.staleBy &&
        !(observed.reconciliation?.action === "bind" && observed.reconciliation.state === "ready") &&
        (["intent", "bound"].includes(observed.status) || observed.status === "running" && unresolvedIO(store.read(scope), observed)) &&
        observed.owner !== "collaboration:queued") {
      // A new scheduler never adopts an old creation/delivery continuation.
      // Preserve the exact native ID/intent and leases for trusted inspection.
      const next = store.transact(scope, s => {
        if (!d.leader()) return;
        const t = s.tasks.find(t => t.id === observed.id)!;
        if (t.owner !== observed.owner || t.status !== observed.status) return;
        t.status = "uncertain";
        t.error = `Previous scheduler's native intent requires manual inspection; original session ${t.sessionId ?? t.dispatch?.sessionId ?? "unbound legacy ID"}. No automatic recreation/redelivery/unlock`;
        bumpIO(t); s.revision++;
        audit(s, "dispatch.restart_requires_inspection", { kind: "system" }, t.id);
        return structuredClone(s);
      });
      if (next) await d.announce(next);
      continue;
    }
    if (!observed.sessionId) {
      if (observed.owner !== d.owner && observed.status === "intent") {
        const next = store.transact(scope, s => {
          if (!d.leader()) return;
          const t = s.tasks.find(t => t.id === observed.id)!;
          if (t.sessionId || t.status !== "intent") return;
          t.status = "uncertain"; t.error = "Creation owner changed; trusted dispatch recovery required"; bumpIO(t); s.revision++;
          return structuredClone(s);
        });
        if (next) await d.announce(next);
      }
      continue;
    }
    try {
      let state = store.read(scope);
      if (unresolvedIO(state, observed)) continue;
      const run = state.runs.find(r => r.id === observed.runId)!;
      if (run.status === "cancelled" || ["cancelled", "superseded"].includes(observed.status) || observed.child?.staleBy || state.attempts.find(a => a.id === observed.attemptId)?.supersededBy) {
        await adapter.interrupt(observed.sessionId);
        const cancelled = await adapter.cancelQueuedCollaboration(observed.sessionId, state.messages.filter(m => m.to === observed.memberId && m.status !== "acknowledged").map(m => m.id));
        if (cancelled.length) {
          const next = store.transact(scope, s => {
            const t = s.tasks.find(t => t.id === observed.id)!;
            for (const m of s.messages.filter(m => cancelled.includes(m.id) && m.status !== "acknowledged")) {
              m.status = "cancelled"; m.error = "Native queued message cancelled, not handled acknowledgement";
            }
            bumpIO(t); s.revision++; return structuredClone(s);
          });
          await d.announce(next);
        }
      }
      // Capture AFTER our own cancellations, BEFORE every native observation.
      state = store.read(scope); observed = structuredClone(state.tasks.find(t => t.id === initial.id)!);
      if (recoveryBlocks(observed) || unresolvedIO(state, observed) || ["bound", "uncertain"].includes(observed.status)) continue;
      const native = await adapter.inspectDispatch(scope, observed);
      if (!native.exists || native.busy || native.inboxIds.length) continue;
      const next = store.transact(scope, s => {
        if (!d.leader()) return;
        const t = s.tasks.find(t => t.id === observed.id)!;
        if (!mayRelease(s, observed, t) || t.status !== observed.status) return;
        t.slotHeld = false; bumpIO(t);
        if (t.writes) store.release(writerKey(scope), t.id);
        const a = s.attempts.find(a => a.id === t.attemptId)!;
        const question = blockingQuestion(s, t);
        if (!question && !t.child && t.executionMode !== "conversation" && t.status === "running" && a.status === "running") {
          a.status = "failed"; a.reason = "Real session ended without structured workflow submission";
          t.error = a.reason;
        } else if (!question && t.child && t.status === "running") t.error = "Auxiliary session ended without member.finish; follow-up or trusted termination needed";
        audit(s, "session.reconciled", { kind: "system" }, `${t.id}: epoch ${observed.ioEpoch ?? 0}; native idle/tools/shell/inbox safe`);
        advance(s); s.revision++; return structuredClone(s);
      });
      if (next) await d.announce(next);
    } catch (error) {
      const next = store.transact(scope, s => {
        if (!d.leader()) return;
        const t = s.tasks.find(t => t.id === initial.id)!;
        const message = error instanceof Error ? error.message : "Native safety observation unavailable";
        if (t.error === message) return;
        t.error = message; s.revision++; return structuredClone(s);
      });
      if (next) await d.announce(next);
    }
  }
}
