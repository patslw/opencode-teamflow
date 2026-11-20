import type { Plugin } from "@opencode/plugin";
import { z } from "zod";
import { AgentCommandSchema, type BackendScope, type TeamflowService } from "../../packages/protocol/src/index.js";
import { conversationEligible, recoveryBlocks } from "./execution-fence.js";
import { sealedRound, visibleMessage } from "./topic-policy.js";
import { blockingQuestion, isDiscussion } from "./questions.js";
import { allowsDiscussionTool, TEAMFLOW_TOOL_NAMESPACE, teamflowToolInstructions } from "./tool-contract.js";
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
    name: "command", description: "Tracked Teamflow submissions and collaboration. Use question.ask with {question} to ask the actual user a business question, then finish the turn and wait. Identity comes from this real session. No user answers, approval, publish, patch.apply or correction.apply.",
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
  const discussionSession = (s: Awaited<ReturnType<TeamflowService["snapshot"]>>, sessionId: string) => {
    const member = s.members.find(m => m.sessionId === sessionId);
    const t = member && s.tasks.find(t => t.id === member.taskId);
    return !!t && isDiscussion(s, t.attemptId);
  };
  await ctx.session.hook("context", async event => {
    const s = await service.snapshot(scope);
    if (discussionSession(s, event.sessionID)) {
      for (const name of Object.keys(event.tools)) if (!allowsDiscussionTool(name)) delete event.tools[name];
    }
    if (s.members.some(m => m.sessionId === event.sessionID) || s.runs.some(r => r.entry?.sessionId === event.sessionID) ||
        s.drafts.some(d => d.designer?.sessionId === event.sessionID)) {
      event.system.push({ type: "text", text: teamflowToolInstructions });
    }
  });
  await ctx.tool.hook("execute.before", async event => {
    if (!allowsDiscussionTool(event.tool) && discussionSession(await service.snapshot(scope), event.sessionID)) {
      throw new Error("需求讨论只允许读取资料和使用 Teamflow 对话工具；禁止改文件、shell、委派及外部工具");
    }
  });
  // The Code Mode fetch extension bypasses tool hooks and asserts the native
  // "webfetch" action directly. Also protect already-created discussion sessions.
  await ctx.permission.hook("evaluate", async event => {
    if (!allowsDiscussionTool(event.action) && discussionSession(await service.snapshot(scope), event.sessionID)) {
      event.effect = "deny";
      event.message = "需求讨论只读：禁止改文件、shell、委派及外部请求";
    }
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
        return { content: JSON.stringify({
          revision: s.revision, self: m, task: s.tasks.find(t => t.id === m.taskId),
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
