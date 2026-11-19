import type { Plugin } from "@opencode/plugin";
import { z } from "zod";
import { AgentCommandSchema, type BackendScope, type TeamflowService } from "../../packages/protocol/src/index.js";
import { conversationEligible, recoveryBlocks } from "./execution-fence.js";
import { sealedRound, visibleMessage } from "./topic-policy.js";
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
    name: "teamflow_command", description: "Tracked Teamflow submissions/collaboration, or authorized independent designer draft.save/patch.propose. Identity comes from this real session. No user approval, publish, patch.apply or correction.apply.",
    input: AgentCommandSchema,
    execute: async (command, tool) => {
      const snapshot = await service.snapshot(scope);
      if (!snapshot.members.some(m => m.sessionId === tool.sessionID) && !snapshot.drafts.some(d => d.designer?.state === "ready" && d.designer.sessionId === tool.sessionID)) throw new Error("Session is not a registered Teamflow member/designer");
      const result = await service.apply({ scope, requestId: tool.id, expectedRevision: snapshot.revision, command }, { kind: "agent", sessionId: tool.sessionID });
      try { await changed(result.revision); } catch { result.resyncRequired = true; }
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
  await ctx.tool.transform(editor => {
    registerTeamflowTools({ scope, changed, register: definition => editor.add(definition) }, service);
    editor.add({
      name: "teamflow_context", description: "Read linked Teamflow run status in a main chat, or your registered member inbox, bounded discussions and corrections. No other sessions' transcripts.",
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
            instruction: "Read-only Teamflow main chat. The user opens /teamflow or the web run to manage stages, members, private messages, topics or approvals. Never use a native subagent to do Teamflow work.",
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
