import { createHash } from "node:crypto";
import { CommandSchema, defaults, MutationEnvelopeSchema, type ActorContext, type BackendScope, type MutationEnvelope, type MutationResult, type Run, type TeamflowService } from "../../packages/protocol/src/index.js";
import { advance, audit, executeSubmission, now, startAttempts, uid } from "./engine.js";
import { validateVersion } from "./model.js";
import type { TeamflowStore } from "./store.js";
import type { OpenCodeAdapter } from "./opencode-adapter.js";
import { existingRequestResult, reconcileDispatch } from "./dispatch.js";
import { collaborate, settleTopics } from "./collaboration.js";
import { reconcileMessage } from "./message-recovery.js";
import { editDraft } from "./drafts.js";
import { design } from "./designer.js";
import { patchCommand, settlePatches } from "./patches.js";
import { activeEscalation, preserveLegacyEscalation } from "./escalation.js";

export function createTeamflowService({ store, adapter }: { store: TeamflowStore; adapter: OpenCodeAdapter }): TeamflowService & { assertSession(scope: BackendScope, sessionId: string): Promise<void> } {
  return {
    async snapshot(scope) { return store.read(scope); },
    async assertSession(scope, sessionId) {
      const s = store.read(scope);
      if (!s.members.some(m => m.sessionId === sessionId) && !s.drafts.some(d => d.designer?.sessionId === sessionId) &&
        !s.runs.some(r => r.entry?.sessionId === sessionId && r.entry.state === "ready")) throw new Error("Session is not registered in this scope");
    },
    async apply(input: MutationEnvelope, actor: ActorContext): Promise<MutationResult> {
      const envelope = MutationEnvelopeSchema.parse(input);
      const fingerprint = createHash("sha256").update(JSON.stringify({ command: envelope.command, actor })).digest("hex");
      if (envelope.command.type === "draft.design" || envelope.command.type === "draft.discuss") return design({ store, adapter, envelope, actor, fingerprint });
      if (envelope.command.type === "dispatch.reconcile") return reconcileDispatch({ store, adapter, envelope, payload: envelope.command.payload, actor, fingerprint });
      if (envelope.command.type === "message.reconcile") return reconcileMessage({ store, adapter, envelope, payload: envelope.command.payload, actor, fingerprint });
      if (envelope.command.type === "run.start" && envelope.command.payload.mainSessionId) {
        if (actor.kind !== "user") throw new Error("Only user may start a run");
        const prior = existingRequestResult(store, store.read(envelope.scope), envelope.requestId, fingerprint);
        if (prior) return prior;
        await adapter.assertMainSession(envelope.scope, envelope.command.payload.mainSessionId);
      }
      if (envelope.command.type === "draft.publish") {
        const draftId = envelope.command.payload.draftId;
        const snapshot = store.read(envelope.scope);
        const prior = existingRequestResult(store, snapshot, envelope.requestId, fingerprint);
        if (prior) return prior;
        const d = snapshot.drafts.find(d => d.id === draftId);
        if (actor.kind !== "user") throw new Error("Only user may publish");
        if (!d?.designer || !d.designer.deliveries.some(m => m.state === "admitted") || d.designer.deliveries.some(m => m.state !== "admitted")) throw new Error("Discuss in the independent designer session and resolve any unknown native admission before publication");
        // Native disappearance is a visible failure boundary, never a fallback
        // session. The final transaction still checks the expected revision.
        await adapter.getSession(d.designer.sessionId);
      }
      return store.transact(envelope.scope, s => {
        const prior = existingRequestResult(store, s, envelope.requestId, fingerprint);
        if (prior) return prior;
        if (envelope.expectedRevision !== s.revision) throw new Error(`Revision conflict: expected ${envelope.expectedRevision}, current ${s.revision}; refresh snapshot`);
        const c = CommandSchema.parse(envelope.command);
        if (actor.kind === "system") throw new Error("System commands are internal only");
        if (actor.kind === "agent" && s.drafts.some(d => d.designer?.sessionId === actor.sessionId) && !["draft.save", "patch.propose"].includes(c.type)) throw new Error("Independent designer can only edit its assigned draft or propose its patch");
        switch (c.type) {
          case "run.start": {
            if (actor.kind !== "user") throw new Error("Only user may start a run");
            const p = c.payload;
            if (s.runs.some(r => r.id === p.runId)) throw new Error("Run already exists");
            if (p.mainSessionId && (s.members.some(m => m.sessionId === p.mainSessionId) || s.drafts.some(d => d.designer?.sessionId === p.mainSessionId) ||
              s.runs.some(r => r.entry?.sessionId === p.mainSessionId && !["completed", "cancelled", "failed"].includes(r.status)))) throw new Error("The session is already a Teamflow private session or is bound to a live run");
            const version = s.versions.find(v => v.id === p.versionId);
            if (!version) throw new Error("Unknown published version");
            validateVersion(version); // Legacy catalog entries must obey supported semantics too.
            const run: Run = { id: p.runId, versionId: p.versionId, label: p.label, brief: p.brief ?? p.label, status: "running",
              entry: p.mainSessionId
                ? { sessionId: p.mainSessionId, source: "existing", state: "ready" }
                : { sessionId: `ses_${uid().replaceAll("-", "")}`, source: "teamflow", state: "pending" },
              config: { activeSlots: p.config?.activeSlots ?? defaults.activeSlots, childDepth: p.config?.childDepth ?? defaults.childDepth, reworkAttempts: p.config?.reworkAttempts ?? defaults.reworkAttempts }, createdAt: now() };
            s.runs.push(run); startAttempts(s, run); break;
          }
          case "run.pause": case "run.resume": case "run.cancel": {
            if (actor.kind !== "user") throw new Error("Only user may control run lifecycle");
            const run = s.runs.find(r => r.id === c.payload.runId);
            if (!run || ["completed", "cancelled", "failed"].includes(run.status)) throw new Error("Unknown/terminal run");
            preserveLegacyEscalation(s, run);
            if (c.type === "run.resume") {
              if (run.status !== "paused") throw new Error("Run is not paused");
              const escalation = activeEscalation(run);
              if (escalation && !escalation.resolution) throw new Error(`Escalation ${escalation.id} requires a relevant user-approved correction/patch fully applied at its safe boundary${escalation.legacy ? "; legacy basis is unknown: apply a new correction/patch covering all current non-end attempts" : ""}`);
              if (s.tasks.some(t => t.runId === run.id && t.status === "uncertain")) throw new Error("Resolve uncertain dispatch by inspecting actual sessions; blind resume/retry refused");
              if (s.corrections.some(x => x.runId === run.id && x.status === "waiting_boundary") || s.patches.some(x => x.runId === run.id && ["waiting_boundary", "review_required"].includes(x.status))) throw new Error("Correction/patch has not safely applied");
              if (escalation) escalation.resumedAt = now();
              run.status = "running"; delete run.waitingReason;
            } else if (c.type === "run.pause") { run.status = "paused"; if (!activeEscalation(run)) run.waitingReason = "User paused scheduling; active tasks may submit"; }
            else {
              run.status = "cancelled";
              s.attempts.filter(a => a.runId === run.id && !["passed", "superseded", "needs_revision"].includes(a.status)).forEach(a => a.status = "cancelled");
              s.tasks.filter(t => t.runId === run.id && !["submitted", "superseded"].includes(t.status)).forEach(t => t.status = "cancelled");
              s.approvals.filter(a => a.runId === run.id).forEach(a => a.valid = false);
            }
            break;
          }
          case "task.submit": case "review.submit": case "gate.approve": case "gate.reject":
            executeSubmission(s, c, actor); break;
          case "template.import": {
            if (actor.kind !== "user") throw new Error("Only user may import published templates");
            const { template, version } = c.payload;
            if (template.id !== version.templateId) throw new Error("Template/version mismatch");
            validateVersion(version);
            if (version.parentVersionId && !s.versions.some(v => v.id === version.parentVersionId && v.templateId === version.templateId)) throw new Error("Unknown parent version");
            store.addVersion(s.scope.backendId, template, version);
            if (!s.templates.some(t => t.id === template.id)) s.templates.push(template);
            if (!s.versions.some(v => v.id === version.id)) s.versions.push(version);
            break;
          }
          default: if (!editDraft(s, c, actor, store) && !patchCommand(s, c, actor) && !collaborate(s, c, actor)) throw new Error(`Unsupported command: ${c.type}`);
        }
        settlePatches(s, store); settleTopics(s); advance(s); s.revision++;
        audit(s, c.type, actor, JSON.stringify(c.payload));
        // RPC output is JSON. Newly-created optional properties may explicitly
        // be undefined internally; never return a committed-but-unencodable body.
        const result = { revision: s.revision, snapshot: JSON.parse(JSON.stringify(s)) };
        store.saveRequest(envelope.scope, envelope.requestId, fingerprint, result);
        return result;
      });
    },
  };
}
