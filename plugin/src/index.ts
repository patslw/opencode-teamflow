import { Plugin } from "@opencode/plugin";
import { TeamflowDemo } from "../../packages/protocol/src/rpc.js";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { OpenCodeAdapter } from "./opencode-adapter.js";
import { createTeamflowService } from "./service.js";
import { openStore } from "./store.js";
import { Scheduler } from "./scheduler.js";
import { registerTools } from "./tools.js";
import { notifyCommitted } from "./notify-committed.js";
import type { BackendScope, MutationResult } from "../../packages/protocol/src/index.js";
import type { RpcRegistration } from "@opencode/plugin/promise/rpc";
import { uid } from "./engine.js";
import { conversationEligible, recoveryBlocks } from "./execution-fence.js";
import { blockingQuestion } from "./questions.js";
import { listCapabilities, taskCapabilities } from "./stage-capabilities.js";

export default Plugin.define({
  id: "teamflow",
  async setup(ctx) {
    if (typeof ctx.options.backendId !== "string" || !ctx.options.backendId.trim()) {
      throw new Error("Teamflow requires an explicit backendId in local plugin options");
    }
    // Every location uses the same backend-level file, never a per-project default.
    const dataDirectory = typeof ctx.options.dataDirectory === "string" ? ctx.options.dataDirectory : fileURLToPath(new URL("../../.runtime/backend-state", import.meta.url));
    const store = await openStore(dataDirectory);
    const scope = { backendId: ctx.options.backendId, projectDirectory: ctx.location.directory };
    store.initialize(scope, join(scope.projectDirectory, ".teamflow/demo.sqlite"));
    const adapter = new OpenCodeAdapter(ctx, memberId => store.read(scope).members.find(member => member.id === memberId)?.sessionId);
    const service = createTeamflowService({ store, adapter });
    const assertScope = (requested: BackendScope) => {
      if (requested.backendId !== scope.backendId || requested.projectDirectory !== scope.projectDirectory) throw new Error("Scope mismatch");
    };
    const formTasks = (runId: string) => {
      const s = store.read(scope);
      if (!s.runs.some(r => r.id === runId && ["running", "waiting"].includes(r.status))) return [];
      return s.tasks.filter(t => t.runId === runId && t.sessionId && t.dispatch?.delivery === "admitted" &&
        t.slotHeld && t.status === "running" && t.executionMode !== "conversation" && conversationEligible(s, t) &&
        !recoveryBlocks(t) && !blockingQuestion(s, t) && taskCapabilities(s, t)?.allowsTool("question") &&
        s.members.some(m => !m.legacy && m.id === t.memberId && m.taskId === t.id && m.sessionId === t.sessionId));
    };
    const registration: RpcRegistration<typeof TeamflowDemo> = await ctx.rpc.register(TeamflowDemo, {
      info: async () => ({ backendId: scope.backendId, directory: ctx.location.directory, version: ctx.app.version, runtime: Object.fromEntries(Object.entries(process.versions).filter((entry): entry is [string, string] => typeof entry[1] === "string")), sqlite: store.sqliteVersion }),
      snapshot: requested => { assertScope(requested); return service.snapshot(requested); },
      capabilities: requested => { assertScope(requested); return listCapabilities(ctx); },
      models: requested => { assertScope(requested); return adapter.listModels(); },
      nativeForms: async input => {
        assertScope(input.scope);
        const tasks = formTasks(input.runId);
        const pending = await Promise.all(tasks.map(async task => ({ task, forms: await adapter.nativeForms(task) })));
        const current = formTasks(input.runId);
        return pending.flatMap(({ task, forms }) => current.some(t => t.id === task.id && t.sessionId === task.sessionId)
          ? forms.filter(f => f.sessionID === task.sessionId && !f.fields.some(field => field.type === "external"))
            .map(f => ({ runId: task.runId, taskId: task.id, attemptId: task.attemptId, sessionId: task.sessionId!, formId: f.id, title: f.title, fields: f.fields }))
          : []);
      },
      nativeFormReply: async input => {
        assertScope(input.scope);
        const assertCurrent = () => {
          const task = formTasks(input.runId).find(t => t.id === input.taskId && t.attemptId === input.attemptId && t.sessionId === input.sessionId);
          if (!task) throw new Error("Form is not bound to a current, executing Teamflow stage");
          return task;
        };
        // Trusted RPC only; never re-admit a prompt or synthesize an answer.
        await adapter.nativeFormReply(assertCurrent(), input.formId, input.answer, assertCurrent);
        return { accepted: true };
      },
      // RPC has no actor identity: authenticated local trusted-client boundary, never input.actor.
      mutate: async (envelope, context) => {
        let result: MutationResult;
        try {
          assertScope(envelope.scope);
          result = await service.apply(envelope, { kind: "user" });
        } catch (error) {
          const reason = error instanceof Error ? error.message : "OpenCode operation failed";
          return context.error("rejected", reason, { reason });
        }
        if (result.inProgress) return result;
        return notifyCommitted(result, () => registration.events.emit("changed", { scope: envelope.scope, revision: result.revision }));
      },
      sessionMessages: async input => { assertScope(input.scope); await service.assertSession(input.scope, input.sessionId); return adapter.listMessages(input.sessionId); },
      sessionSend: async input => {
        assertScope(input.scope); await service.assertSession(input.scope, input.sessionId);
        const snapshot = store.read(scope);
        const member = snapshot.members.find(m => m.sessionId === input.sessionId);
        if (!member) throw new Error("Independent designer discussion requires journaled draft.discuss, not legacy sessionSend");
        const task = snapshot.tasks.find(t => t.id === member.taskId);
        if (!task || !conversationEligible(snapshot, task)) throw new Error("Cancelled/superseded/uncertain task cannot be revived; use current session or trusted recovery");
        // Legacy entrypoint remains admission-only; current clients use mutate
        // with MutationRetry. Never call native prompt/resume outside scheduler.
        const result = await service.apply({ scope, requestId: `legacy-session-send:${uid()}`, expectedRevision: snapshot.revision,
          command: { type: "message.send", payload: { runId: member.runId, toMemberId: member.id, text: input.text } } }, { kind: "user" });
        return notifyCommitted(result, () => registration.events.emit("changed", { scope, revision: result.revision }));
      },
    });
    const changed = async (revision: number) => { await registration.events.emit("changed", { scope, revision }); };
    await registerTools(ctx, scope, service, changed);
    const scheduler = new Scheduler(store, adapter, scope, async snapshot => {
      // Post-commit event failure must never be reclassified as dispatch failure.
      try { await changed(snapshot.revision); } catch { /* clients also poll snapshots */ }
    });
    const timer = setInterval(() => { void scheduler.tick().catch(error => console.error("Teamflow scheduler:", error instanceof Error ? error.message : "unavailable")); }, 1000);
    return () => { clearInterval(timer); scheduler.stop(); /* In-flight calls may still reconcile; do not close their SQLite handle. */ };
  },
});
