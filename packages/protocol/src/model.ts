import { z } from "zod";

const id = z.string().min(1);
export const BackendScopeSchema = z.object({ backendId: id, projectDirectory: id }).strict();
export type BackendScope = z.infer<typeof BackendScopeSchema>;
export type ActorContext = { kind: "user" } | { kind: "agent"; sessionId: string } | { kind: "system" };
export const RoleSchema = z.object({
  id, agent: id, responsibility: id, prompt: id, skills: z.array(id),
  model: z.object({ providerID: id, id }).strict().optional(),
  permissions: z.array(id), childRoles: z.array(id), maxDepth: z.number().int().min(0).max(2),
}).strict();
export const NodeSchema = z.object({
  id, name: id, kind: z.enum(["work", "review", "test", "gate", "end"]),
  role: id.optional(), mode: z.enum(["demo", "formal", "analysis"]), prompt: id,
  inputs: z.array(id), deliverables: z.array(id), criteria: z.array(id), criteriaRevision: id,
  writes: z.boolean(), sourceNodeId: id.optional(),
  gate: z.object({ user: z.boolean(), reviewRoles: z.array(id), testRoles: z.array(id) }).strict().optional(),
}).strict();
export const EdgeSchema = z.object({ from: id, to: id, kind: z.enum(["normal", "return"]) }).strict();
export const GraphSchema = z.object({ entry: id, nodes: z.array(NodeSchema), edges: z.array(EdgeSchema), requiredGateIds: z.array(id) }).strict();
export const TemplateSchema = z.object({ id, name: id, description: z.string() }).strict();
export const VersionSchema = z.object({
  id, templateId: id, parentVersionId: id.optional(), graph: GraphSchema, roles: z.array(RoleSchema),
  releaseNotes: z.string(), digest: id, publishedAt: id,
}).strict();
export const RunSchema = z.object({
  id, versionId: id, label: id, brief: id, status: z.enum(["running", "waiting", "paused", "completed", "failed", "cancelled"]),
  config: z.object({ activeSlots: z.number().int().min(1).max(16), childDepth: z.number().int().min(0).max(2), reworkAttempts: z.number().int().min(0).max(10) }).strict(),
  createdAt: id, waitingReason: z.string().optional(),
  escalations: z.array(z.object({
    id, reason: id, createdAt: id, versionId: id, affectedAttemptIds: z.array(id),
    legacy: z.boolean().optional(),
    resolution: z.object({ kind: z.enum(["correction", "patch"]), id, appliedAt: id }).strict().optional(),
    resumedAt: id.optional(),
  }).strict()).optional(),
}).strict();
export const AttemptSchema = z.object({
  id, runId: id, nodeId: id, versionId: id.optional(), round: z.number().int().positive(),
  status: z.enum(["pending", "ready", "running", "awaiting_gate", "passed", "needs_revision", "failed", "cancelled", "superseded"]),
  criteriaRevision: id, requirements: z.string().optional(), reworkCount: z.number().int().nonnegative().optional(), previousAttemptId: id.optional(), supersededBy: id.optional(), reason: z.string().optional(), createdAt: id,
}).strict();
export const MemberSchema = z.object({
  id, runId: id, role: id, sessionId: id, parentMemberId: id.optional(),
  taskId: id.optional(), legacy: z.boolean().optional(),
}).strict();
export const TaskSchema = z.object({
  id, runId: id, attemptId: id, memberId: id, writes: z.boolean(),
  status: z.enum(["intent", "bound", "running", "submitted", "uncertain", "cancelled", "superseded"]),
  sessionId: id.optional(), dispatchId: id, error: z.string().optional(), slotHeld: z.boolean(),
  owner: id, createdAt: id,
  ioEpoch: z.number().int().nonnegative().optional(),
  executionMode: z.enum(["workflow", "conversation"]).optional(),
  messageRecovery: z.object({ requestId: id, messageId: id, state: z.enum(["checking", "blocked", "observed", "terminated"]), evidence: z.array(z.string()) }).strict().optional(),
  messageInspection: z.object({ requestId: id, messageId: id, state: z.enum(["checking", "blocked", "observed"]), evidence: z.array(z.string()) }).strict().optional(),
  child: z.object({
    parentMemberId: id, role: id, brief: id, result: z.string().optional(),
    basisAttemptId: id.optional(), criteriaRevision: id.optional(), requirements: z.string().optional(),
    staleBy: id.optional(), completedAt: id.optional(), topicId: id.optional(), unrelatedReason: id.optional(), relayMessageId: id.optional(),
  }).strict().optional(),
  legacyFenceProcess: id.optional(),
  inspection: z.object({ requestId: id, state: z.enum(["checking", "observed", "blocked"]), evidence: z.array(z.string()) }).strict().optional(),
  dispatch: z.object({
    sessionId: id, brief: z.string(), role: id,
    process: id.optional(),
    create: z.enum(["not_started", "pending", "succeeded", "failed", "not_sent"]),
    delivery: z.enum(["not_started", "pending", "admitted", "failed", "not_sent", "terminated"]),
  }).strict().optional(),
  reconciliation: z.object({
    requestId: id, action: z.enum(["inspect", "bind", "terminate"]),
    state: z.enum(["checking", "ready", "bound", "terminated", "blocked"]),
    reason: id, evidence: z.array(z.string()),
  }).strict().optional(),
}).strict();
export const EvidenceSchema = z.object({
  command: id, exitCode: z.number().int(), output: z.string(), version: id,
  source: z.enum(["self_report", "independent_execution"]),
}).strict();
export const DeliverySchema = z.object({
  id, runId: id, attemptId: id, memberId: id, sessionId: id, artifactRevision: id,
  criteriaRevision: id, artifacts: z.array(id).min(1), summary: id, checks: z.array(EvidenceSchema),
  unresolved: z.array(id), createdAt: id, staleBy: id.optional(),
}).strict();
export const ApprovalSchema = z.object({
  id, runId: id, attemptId: id, targetAttemptId: id, deliveryId: id,
  artifactRevision: id, criteriaRevision: id, kind: z.enum(["user", "review", "test"]),
  actorId: id, role: id.optional(), verdict: z.enum(["pass", "needs_revision", "reject"]),
  issues: z.array(id), evidence: z.array(EvidenceSchema), valid: z.boolean(), createdAt: id,
}).strict();
export const MessageSchema = z.object({
  id, runId: id, from: id, to: id, text: id,
  senderKind: z.enum(["user", "agent", "system"]).optional(),
  continuationAuthorized: z.boolean().optional(),
  status: z.enum(["intent", "delivered", "acknowledged", "uncertain", "cancelled", "undelivered"]),
  admission: z.enum(["pending", "accepted", "observed_inbox", "observed_context"]).optional(),
  taskId: id.optional(), topicId: id.optional(), correctionId: id.optional(), error: z.string().optional(),
   unrelatedReason: id.optional(), relayMessageId: id.optional(), patchId: id.optional(),
  topicRound: z.number().int().positive().optional(),
  topicStage: z.enum(["question", "exchange", "associated", "conclusion"]).optional(),
  request: z.object({ token: id, process: id, state: z.enum(["in_flight", "unknown", "settled", "not_sent"]), text: z.string(), source: id }).strict().optional(),
  createdAt: id, acknowledgedAt: id.optional(),
}).strict();
export const TopicSchema = z.object({ id, runId: id, question: id, participants: z.array(id), relatedTaskIds: z.array(id).optional(), round: z.number().int(), status: z.enum(["open", "resolved", "escalated"]), responses: z.array(z.object({ memberId: id, text: id, round: z.number().int().optional(), evidence: z.array(id).optional() })), conclusion: z.string().optional(), actionItems: z.array(id).optional(), escalationReason: z.string().optional(), unrelatedReason: id.optional() }).strict();
export const PatchSchema = z.object({
  id, runId: id, baseVersionId: id, proposedVersionId: id, draftId: id.optional(), reason: id,
  affectedNodeIds: z.array(id), status: z.enum(["proposed", "waiting_boundary", "review_required", "superseded", "applied", "rejected"]),
  mappings: z.array(z.object({ nodeId: id, action: z.enum(["retain", "replace", "remove"]), replacementNodeId: id.optional() }).strict()).optional(),
  affectedAttemptIds: z.array(id).optional(), notificationIds: z.array(id).optional(),
  replacementAttemptIds: z.array(id).optional(), approvedAt: id.optional(), appliedAt: id.optional(),
  reviewRequired: z.object({ reason: id, detectedAt: id, affectedNodeIds: z.array(id) }).strict().optional(),
  replacesPatchId: id.optional(), replacementPatchId: id.optional(), escalationId: id.optional(),
}).strict();
export const DesignerSchema = z.object({
  sessionId: id, state: z.enum(["creating", "ready", "unknown"]), createdAt: id,
  error: z.string().optional(),
  deliveries: z.array(z.object({ id, text: id, state: z.enum(["pending", "admitted", "unknown"]), at: id, error: z.string().optional() }).strict()),
}).strict();
export const DraftSchema = z.object({
  id, templateId: id, name: id.optional(), baseVersionId: id.optional(), revision: z.number().int().nonnegative(),
  graph: GraphSchema, roles: z.array(RoleSchema), description: z.string(), designer: DesignerSchema.optional(),
}).strict();
export const CorrectionSchema = z.object({
  id, runId: id, reason: id, affectedAttemptIds: z.array(id),
  requirements: z.string().optional(), criteriaRevision: id.optional(),
  affectedNodeIds: z.array(id).optional(), notificationIds: z.array(id).optional(), replacementAttemptIds: z.array(id).optional(),
  status: z.enum(["proposed", "waiting_boundary", "applied"]), escalationId: id.optional(),
}).strict();
export const AuditSchema = z.object({ id, at: id, type: id, actor: id, detail: z.string() }).strict();
export const SnapshotSchema = z.object({
  scope: BackendScopeSchema, revision: z.number().int().nonnegative(),
  templates: z.array(TemplateSchema), versions: z.array(VersionSchema), runs: z.array(RunSchema),
  members: z.array(MemberSchema), tasks: z.array(TaskSchema), attempts: z.array(AttemptSchema),
  deliveries: z.array(DeliverySchema), approvals: z.array(ApprovalSchema), messages: z.array(MessageSchema),
  topics: z.array(TopicSchema), patches: z.array(PatchSchema),
  drafts: z.array(DraftSchema), corrections: z.array(CorrectionSchema), audit: z.array(AuditSchema),
}).strict();
export type TeamflowSnapshot = z.infer<typeof SnapshotSchema>;
export type WorkflowVersion = z.infer<typeof VersionSchema>;
export type WorkflowTemplate = z.infer<typeof TemplateSchema>;
export type WorkflowGraph = z.infer<typeof GraphSchema>;
export type WorkflowNode = z.infer<typeof NodeSchema>;
export type WorkflowRole = z.infer<typeof RoleSchema>;
export type StageAttempt = z.infer<typeof AttemptSchema>;
export type Run = z.infer<typeof RunSchema>;
export type Member = z.infer<typeof MemberSchema>;
export type Task = z.infer<typeof TaskSchema>;
export type Delivery = z.infer<typeof DeliverySchema>;
export type Approval = z.infer<typeof ApprovalSchema>;
export type Evidence = z.infer<typeof EvidenceSchema>;
export type TeamflowMessage = z.infer<typeof MessageSchema>;
export type Topic = z.infer<typeof TopicSchema>;
export type WorkflowPatch = z.infer<typeof PatchSchema>;
export type WorkflowDraft = z.infer<typeof DraftSchema>;
export type Correction = z.infer<typeof CorrectionSchema>;
export const defaults = { activeSlots: 4, childDepth: 2, topicRounds: 3, reworkAttempts: 3 } as const;
