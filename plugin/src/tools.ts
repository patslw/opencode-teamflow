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
      name: "teamflow_context", description: "Read registered run peers, your inbox and tracking, bounded discussion and correction status. No coordinator transcript or other sessions' text.",
      input: z.object({}).strict(),
      execute: async (_input, context) => {
        const s = await service.snapshot(scope), m = s.members.find(m => m.sessionId === context.sessionID);
        const draft = s.drafts.find(d => d.designer?.state === "ready" && d.designer.sessionId === context.sessionID);
        if (draft) return { content: JSON.stringify({
          revision: s.revision, draft, base: s.versions.find(v => v.id === draft.baseVersionId),
          patches: s.patches.filter(p => p.draftId === draft.id),
          instruction: "Only draft.save for this exact draft ID/revision and patch.propose for its content. No user publish/apply/Gate rights. Re-read and compare on conflict. No file writes/shell/delegation.",
        }) };
        if (!m) throw new Error("Session is not a registered Teamflow member");
        const task = s.tasks.find(t => t.id === m.taskId);
        if (!task?.slotHeld || !conversationEligible(s, task) || recoveryBlocks(task)) return { content: JSON.stringify({ self: m, taskId: task?.id, status: task?.status, instruction: "No current scheduler execution authority; context bodies hidden. Ask user for controlled continuation/recovery." }) };
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
