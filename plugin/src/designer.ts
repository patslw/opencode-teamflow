import type { ActorContext, MutationEnvelope, MutationResult } from "../../packages/protocol/src/index.js";
import type { TeamflowStore } from "./store.js";
import type { OpenCodeAdapter } from "./opencode-adapter.js";
import { audit, now, uid } from "./engine.js";
import { backendProcessIdentity, existingRequestResult } from "./dispatch.js";

/** Independent identity, never a fabricated execution member. Unknown native calls
 * remain reserved; replay only observes the same request and never creates anew. */
export async function design(deps: { store: TeamflowStore; adapter: OpenCodeAdapter; envelope: MutationEnvelope; actor: ActorContext; fingerprint: string }): Promise<MutationResult> {
  const { store, adapter, envelope: e, actor, fingerprint } = deps, c = e.command;
  if (actor.kind !== "user" || !["draft.design", "draft.discuss"].includes(c.type)) throw new Error("Only user may start/discuss independent design");
  if (c.type !== "draft.design" && c.type !== "draft.discuss") throw new Error("Invalid design operation");
  if (c.type === "draft.design" && c.payload.agent !== "teamflow-process-designer") throw new Error("Use the shipped read-only teamflow-process-designer role; no fallback to build");
  const token = uid(), resource = `designer:${c.payload.draftId}`;
  const initial = store.transact(e.scope, s => {
    const prior = existingRequestResult(store, s, e.requestId, fingerprint);
    if (prior) return { prior };
    if (s.revision !== e.expectedRevision) throw new Error(`Revision conflict: current ${s.revision}; refresh and compare`);
    const d = s.drafts.find(d => d.id === c.payload.draftId);
    if (!d) throw new Error("Save the draft first");
    if (store.pendingRequestForTask(e.scope, resource)) throw new Error("Designer native operation unresolved; inspect the original request/session, never recreate");
    if (c.type === "draft.design") {
      if (d.designer) throw new Error("This draft already has a designer mapping; missing native sessions must not be replaced");
      d.designer = { sessionId: `ses_${uid().replaceAll("-", "")}`, state: "creating", createdAt: now(), deliveries: [] };
    } else {
      if (d.designer?.state !== "ready" || d.designer.deliveries.some(x => x.state !== "admitted")) throw new Error("Designer is not ready or has an unresolved admission");
      d.designer.deliveries.push({ id: `msg_${uid().replaceAll("-", "")}`, text: c.payload.text, state: "pending", at: now() });
    }
    store.reserveRequest(e.scope, e.requestId, fingerprint, token, backendProcessIdentity, resource);
    s.revision++; audit(s, c.type + ".intent", actor, JSON.stringify({ draftId: d.id, sessionId: d.designer!.sessionId }));
    return { draft: structuredClone(d) };
  });
  if (initial.prior) return initial.prior;
  const d = initial.draft!, sessionId = d.designer!.sessionId;
  let error: string | undefined;
  try {
    if (c.type === "draft.design") {
      const brief = [
        "Independent Teamflow process designer, NOT an execution member. No run/worktree implementation or delegation.",
        `Authorized draft only: ${d.id}. User problem: ${c.payload.brief}`,
        "Read teamflow_context, edit the returned full draft using teamflow_command draft.save with its exact draft revision. On conflict re-read and compare. Never publish/apply, approve Gates, spawn, write files or run shell commands.",
        "Propose workflow graph/roles/prompts with necessity and impact; only explicit user publication/application changes a run.",
        `Initial draft: ${JSON.stringify(d)}`,
      ].join("\n\n");
      const actual = await adapter.createMember({ scope: e.scope, runId: `design:${d.id}`, memberId: `designer:${d.id}`, role: c.payload.agent, brief, writes: false, sessionId });
      if (actual.sessionId !== sessionId) throw new Error("Designer session identity mismatch");
      await adapter.getSession(sessionId);
    } else {
      // A missing mapped ID is a hard failure, not permission to create another.
      await adapter.getSession(sessionId);
      const message = d.designer!.deliveries.at(-1)!;
      await adapter.deliver({ sessionId, messageId: message.id, text: message.text, source: `user process design for draft ${d.id} (not publish/apply approval)`, intent: "queue" });
    }
  } catch (cause) { error = cause instanceof Error ? cause.message || cause.name : String(cause); }
  return store.transact(e.scope, s => {
    const fresh = s.drafts.find(x => x.id === d.id)!.designer!;
    if (fresh.sessionId !== sessionId) throw new Error("Designer identity changed");
    if (c.type === "draft.design") { fresh.state = error ? "unknown" : "ready"; fresh.error = error; }
    else {
      const message = fresh.deliveries.find(x => x.id === d.designer!.deliveries.at(-1)!.id)!;
      message.state = error ? "unknown" : "admitted"; message.error = error;
    }
    s.revision++; audit(s, c.type + (error ? ".unknown" : ".committed"), actor, JSON.stringify({ draftId: d.id, sessionId, error }));
    const result = { revision: s.revision, snapshot: JSON.parse(JSON.stringify(s)) };
    store.saveRequest(e.scope, e.requestId, fingerprint, result, token);
    return result;
  });
}
