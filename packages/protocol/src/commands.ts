import { z } from "zod";
import { BackendScopeSchema, DraftSchema, EvidenceSchema, PatchSchema, SnapshotSchema, TemplateSchema, VersionSchema } from "./model.js";
const id = z.string().min(1);
const command = <T extends string, S extends z.ZodRawShape>(type: T, shape: S) => z.object({ type: z.literal(type), payload: z.object(shape).strict() }).strict();
const binding = { attemptId: id, deliveryId: id, artifactRevision: id, criteriaRevision: id };
const association = { topicId: id.optional(), unrelatedReason: id.optional(), relayMessageId: id.optional() };
// Named schemas make the model capability allowlist independent of command ordering.
export const AgentCommands = {
  taskSubmit: command("task.submit", { taskId: id, attemptId: id, artifactRevision: id, criteriaRevision: id, artifacts: z.array(id).min(1), summary: id, checks: z.array(EvidenceSchema), unresolved: z.array(id) }),
  reviewSubmit: command("review.submit", { ...binding, targetAttemptId: id, verdict: z.enum(["pass", "needs_revision", "reject"]), issues: z.array(id), evidence: z.array(EvidenceSchema) }),
  memberSpawn: command("member.spawn", { memberId: id, runId: id, role: id, brief: id.max(32000), parentMemberId: id.optional(), ...association }),
  memberFinish: command("member.finish", { taskId: id, summary: id.max(32000), ...association }),
  messageSend: command("message.send", { runId: id, toMemberId: id, text: id, ...association }),
  messageAck: command("message.ack", { messageId: id }),
  topicOpen: command("topic.open", { runId: id, topicId: id, question: id, participantIds: z.array(id), unrelatedReason: id.optional(), sourceTopicId: id.optional() }),
  topicRespond: command("topic.respond", { topicId: id, text: id, evidence: z.array(id).optional() }),
  topicResolve: command("topic.resolve", { topicId: id, conclusion: id, actionItems: z.array(id).optional() }),
  correctionPropose: command("correction.propose", { runId: id, correctionId: id, reason: id, affectedAttemptIds: z.array(id).min(1), requirements: id.max(32000).optional(), criteriaRevision: id.optional() }),
  draftSave: command("draft.save", { draft: DraftSchema }),
  patchPropose: command("patch.propose", { patch: PatchSchema }),
};
export const AgentCommandSchema = z.discriminatedUnion("type", [
  AgentCommands.taskSubmit, AgentCommands.reviewSubmit, AgentCommands.memberSpawn, AgentCommands.memberFinish,
  AgentCommands.messageSend, AgentCommands.messageAck, AgentCommands.topicOpen,
  AgentCommands.topicRespond, AgentCommands.topicResolve, AgentCommands.correctionPropose,
  AgentCommands.draftSave, AgentCommands.patchPropose,
]);
export const CommandSchema = z.discriminatedUnion("type", [
  command("run.start", { runId: id, versionId: id, label: id, brief: id.max(32000).optional(), mainSessionId: id.optional(), config: z.object({ activeSlots: z.number().int().min(1).max(16).optional(), childDepth: z.number().int().min(0).max(2).optional(), reworkAttempts: z.number().int().min(0).max(10).optional() }).strict().optional() }),
  command("run.pause", { runId: id }), command("run.resume", { runId: id }), command("run.cancel", { runId: id }),
  ...AgentCommandSchema.options,
  command("gate.approve", binding), command("gate.reject", { ...binding, reason: id }),
  command("dispatch.reconcile", { taskId: id, action: z.enum(["inspect", "bind", "terminate"]), reason: id, sessionId: id.optional() }),
  command("message.reconcile", { messageId: id, action: z.enum(["inspect", "terminate", "adopt"]), reason: id }),
  command("correction.apply", { correctionId: id }),
  command("draft.publish", { draftId: id, draftRevision: z.number().int().nonnegative(), versionId: id, releaseNotes: z.string() }),
  command("draft.design", { draftId: id, brief: id.max(32000), agent: id }),
  command("draft.discuss", { draftId: id, text: id.max(32000) }),
  command("template.import", { template: TemplateSchema, version: VersionSchema }),
  command("patch.apply", { patchId: id }),
  command("patch.repropose", { patchId: id, replacementPatchId: id, proposedVersionId: id, reason: id }),
]);
export type TeamflowCommand = z.infer<typeof CommandSchema>;
export type CommandPayload<T extends TeamflowCommand["type"]> = Extract<TeamflowCommand, { type: T }>["payload"];
export const MutationEnvelopeSchema = z.object({ scope: BackendScopeSchema, requestId: id, expectedRevision: z.number().int().nonnegative(), command: CommandSchema }).strict();
export type MutationEnvelope = z.infer<typeof MutationEnvelopeSchema>;
export const MutationResultSchema = z.object({
  revision: z.number(), snapshot: SnapshotSchema, resyncRequired: z.boolean().optional(),
  inProgress: z.object({ requestId: id, taskId: id.optional(), reason: z.enum(["request_in_progress", "task_reconciliation_in_progress"]) }).strict().optional(),
});
export type MutationResult = z.infer<typeof MutationResultSchema>;
