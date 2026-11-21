import type { Plugin } from "@opencode/plugin";
import { z } from "zod";
import { AgentCommandSchema, type BackendScope, type TeamflowService } from "../../packages/protocol/src/index.js";
import { conversationEligible, recoveryBlocks } from "./execution-fence.js";
import { sealedRound, visibleMessage } from "./topic-policy.js";
import { blockingQuestion } from "./questions.js";
import { stageCapabilities } from "./stage-capabilities.js";
import { TEAMFLOW_TOOL_NAMESPACE, teamflowToolInstructions } from "./tool-contract.js";
import { availableRouteTargets, enabledModels, mayPlanModels, sameModel } from "./model-routing.js";
export interface PluginToolContext {
  scope: BackendScope;
  changed(revision: number): Promise<void>;
  register(definition: {
    name: string; description: string; input: typeof AgentCommandSchema;
    execute(command: z.infer<typeof AgentCommandSchema>, context: { sessionID: string; id: string }): Promise<{ content: string }>;
  }): void;
}
export function registerTeamflowTools(context: PluginToolContext, service: TeamflowService): void {
  const { scope, changed } = context;
  context.register({
    name: "command", description: "Tracked Teamflow submissions and collaboration. Use question.ask with {question, options?} for a blocking business question. Prefer 2–4 meaningful choices where appropriate; the user can also write an answer. Then finish the turn and wait. model.plan is only for the run's current coordinator to save a candidate and reason for an unclaimed stage or attempt. No user answers, approval, publish, patch.apply or correction.apply.",
    input: AgentCommandSchema,
    execute: async (command, tool) => {
      const snapshot = await service.snapshot(scope);
      if (!snapshot.members.some(m => m.sessionId === tool.sessionID) && !snapshot.drafts.some(d => d.designer?.state === "ready" && d.designer.sessionId === tool.sessionID)) throw new Error("Session is not a registered Teamflow member/designer");
      const apply = (expectedRevision: number) => service.apply({ scope, requestId: tool.id, expectedRevision, command }, { kind: "agent", sessionId: tool.sessionID });
      let result;
      let revision = snapshot.revision;
      for (let retries = 0; ; retries++) {
        try { result = await apply(revision); break; }
        catch (error) {
          if (retries >= 3 || !(error instanceof Error) || !error.message.startsWith("Revision conflict:")) throw error;
          revision = (await service.snapshot(scope)).revision;
        }
      }
      try { await changed(result.revision); } catch { result.resyncRequired = true; }
      if (command.type === "question.ask") {
        const self = result.snapshot.members.find(m => m.sessionId === tool.sessionID);
        const question = result.snapshot.questions.findLast(q => q.memberId === self?.id && q.status === "open");
        return { content: `问题已向用户发出（${question?.id ?? "已记录"}）：${command.payload.question}\n请结束本轮，不要继续派工、改文件或提交。用户回答后会回到本会话；回答不是批准。` };
      }
      if (command.type === "model.plan") return { content: "Model plan recorded for future dispatch. No work was started, no model was changed in an existing session, and no approval was granted." };
      return { content: JSON.stringify({ revision: result.revision, resyncRequired: result.resyncRequired,
        instruction: ["task.submit", "review.submit", "member.finish"].includes(command.type)
          ? "Submission committed. Stop writes and finish. Gate approval remains separate."
          : command.type === "draft.save" || command.type === "patch.propose"
            ? "Draft/proposal committed. Re-read teamflow_context for the current draft revision. No publish/apply/approval was granted."
            : "Intent/state committed, NOT proof of recipient handling. Inspect teamflow_context for admission and explicit acknowledgement. Continue assigned work; conclusions never grant approval." }) };
    },
  });
}
export async function registerTools(ctx: Plugin.Context, scope: BackendScope, service: TeamflowService, changed: (revision: number) => Promise<void>) {
  for (const kind of ["context", "compaction", "generate"] as const) {
    await ctx.session.hook(kind, async event => {
      const s = await service.snapshot(scope);
      const policy = stageCapabilities(s, event.sessionID);
      if (policy) for (const name of Object.keys(event.tools)) if (!policy.allowsTool(name)) delete event.tools[name];
      if (kind === "context" && (policy || s.runs.some(r => r.entry?.sessionId === event.sessionID) ||
          s.drafts.some(d => d.designer?.sessionId === event.sessionID))) {
        event.system.push({ type: "text", text: teamflowToolInstructions });
      }
    });
  }
  await ctx.tool.hook("execute.before", async event => {
    const s = await service.snapshot(scope);
    const policy = stageCapabilities(s, event.sessionID);
    if (!policy) return;
    if (!policy.allowsTool(event.tool)) throw new Error(`Tool ${event.tool} is unavailable for this Teamflow stage and role`);
    const task = s.tasks.find(t => t.sessionId === event.sessionID);
    if (task && (task.child?.staleBy || ["cancelled", "superseded"].includes(task.status) ||
      s.runs.some(run => run.id === task.runId && ["cancelled", "failed"].includes(run.status)))) {
      throw new Error("This Teamflow execution is no longer current");
    }
    if (event.tool === "question") {
      if (!task || !task.slotHeld || task.status !== "running" || task.executionMode === "conversation" ||
        !conversationEligible(s, task) || recoveryBlocks(task) || blockingQuestion(s, task)) {
        throw new Error("Native form requires a current executing member with no Teamflow business question pending");
      }
    }
  });
  // Code Mode fetch bypasses tool hooks and asserts webfetch directly.
  // Never change a host deny/ask into allow.
  await ctx.permission.hook("evaluate", async event => {
    if (event.effect === "deny") return;
    const policy = stageCapabilities(await service.snapshot(scope), event.sessionID);
    if (!policy || policy.allowsAction(event.action, event.resources)) return;
    const nativeActions = ["edit", "shell", "subagent", "skill", "read", "glob", "grep", "webfetch", "websearch", "question"];
    if (!nativeActions.includes(event.action) && (await ctx.tool.list()).some(tool =>
      tool.options?.permission === event.action && policy.allowsTool(tool.id))) return;
    event.effect = "deny";
    event.message = `Permission ${event.action} is unavailable for this Teamflow stage and role`;
  });
  await ctx.tool.transform(editor => {
    editor.namespace({ name: TEAMFLOW_TOOL_NAMESPACE, description: "Teamflow run context, member questions, and tracked workflow commands" });
    const options = { namespace: TEAMFLOW_TOOL_NAMESPACE, codemode: true, pinned: true } as const;
    registerTeamflowTools({ scope, changed, register: definition => editor.add({ ...definition, options }) }, service);
    editor.add({
      name: "context", options, description: "Read linked Teamflow run status in a main chat, or your registered member inbox, bounded discussions and corrections. No other sessions' transcripts.",
      input: z.object({}).strict(),
      execute: async (_input, context) => {
        const s = await service.snapshot(scope), m = s.members.find(m => m.sessionId === context.sessionID);
        const draft = s.drafts.find(d => d.designer?.state === "ready" && d.designer.sessionId === context.sessionID);
        if (draft) return { content: JSON.stringify({
          revision: s.revision, draft, base: s.versions.find(v => v.id === draft.baseVersionId),
          patches: s.patches.filter(p => p.draftId === draft.id),
          instruction: "Only draft.save for this exact draft ID/revision and patch.propose for its content. No user publish/apply/Gate rights. Re-read and compare on conflict. No file writes/shell/delegation.",
        }) };
        if (!m) {
          const runs = s.runs.filter(r => r.entry?.sessionId === context.sessionID && r.entry.state === "ready");
          const run = runs.findLast(r => ["running", "waiting", "paused"].includes(r.status)) ?? runs.at(-1);
          if (!run) throw new Error("Session is not registered in Teamflow");
          return { content: JSON.stringify({
            run, attempts: s.attempts.filter(a => a.runId === run.id && !a.supersededBy),
            members: s.members.filter(m => m.runId === run.id).map(m => ({ id: m.id, role: m.role, parentMemberId: m.parentMemberId })),
            topics: s.topics.filter(t => t.runId === run.id).map(t => ({ id: t.id, question: t.question, status: t.status })),
            questions: s.questions.filter(q => q.runId === run.id),
            instruction: "Read-only Teamflow main chat. The user opens /teamflow or the web run to answer member questions or separately approve gates. Never use a native subagent to do Teamflow work.",
          }) };
        }
        const task = s.tasks.find(t => t.id === m.taskId);
        if (!task?.slotHeld || !conversationEligible(s, task, true) || recoveryBlocks(task)) return { content: JSON.stringify({ self: m, taskId: task?.id, status: task?.status, instruction: "No current scheduler execution authority; context bodies hidden. Ask user for controlled continuation/recovery." }) };
        if (s.runs.find(run => run.id === m.runId)?.status === "paused") return { content: JSON.stringify({
          self: m, taskId: task.id, status: task.status,
          instruction: "Teamflow is paused. Finish the already admitted turn only. Submit its actual result with the original task.submit, review.submit or member.finish as instructed, or acknowledge a message already delivered to this turn. No new work, spawn, discussion or Gate action. This receipt does not start another turn.",
        }) };
        const run = s.runs.find(run => run.id === m.runId);
        let modelRouting;
        if (run && mayPlanModels(s, run, context.sessionID)) {
          const candidates = run.modelRouting?.candidates ?? [];
          const catalog = candidates.length ? await enabledModels(ctx).catch(() => undefined) : [];
          modelRouting = {
            runId: run.id,
            candidates: candidates.map(c => ({ ...c, enabled: catalog?.some(row => sameModel(row.model, c.model)) ?? null })),
            targets: availableRouteTargets(s, run),
            plans: run.modelRouting?.plans ?? [],
            instruction: candidates.length
              ? 'Choose an enabled candidate using task difficulty and specialties in tags/purpose. Save relevant unclaimed stages (when stageChoiceAvailable) or exact attempts with model.plan {runId,target:{kind:"stage"|"attempt",id},versionId,choice:{model:{providerID,id},reason}}; copy the target versionId, explain the tradeoff, leave unnecessary choices unset. No permissions, Gate or existing session changes.'
              : "No user-approved model candidates; leave the existing defaults. The user can configure the pool in the web run.",
          };
        }
        return { content: JSON.stringify({
          revision: s.revision, self: m, task: s.tasks.find(t => t.id === m.taskId),
          modelRouting,
          peers: s.members.filter(p => p.runId === m.runId),
          questions: s.questions.filter(q => q.taskId === task.id).map(q => q.status === "answered" && blockingQuestion(s, task)?.id === q.id ? { ...q, answer: undefined } : q),
          messages: s.messages.filter(x => x.runId === m.runId && (x.to === m.id || x.from === m.id)).map(x => visibleMessage(s, x, m.id) ? { ...x, request: undefined } : {
            id: x.id, from: x.from, to: x.to, status: x.status, admission: x.admission, topicId: x.topicId,
            error: x.error, instruction: "Metadata only: intent/uncertain/cancelled or topic-barrier body is NOT delivered",
          }),
          topics: s.topics.filter(t => t.runId === m.runId && t.participants.includes(m.id)).map(t => ({ ...t,
            responses: t.responses.filter(r => r.memberId === m.id || sealedRound(s, t.id, r.round ?? 1)) })),
          corrections: s.corrections.filter(c => c.runId === m.runId),
        }) };
      },
    });
  });
}
