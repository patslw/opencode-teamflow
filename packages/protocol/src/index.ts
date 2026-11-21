export * from "./model.js";
export * from "./commands.js";
export * from "./workflow-diff.js";
import type { ActorContext, BackendScope, ModelRef, TeamflowSnapshot } from "./model.js";
import type { MutationEnvelope, MutationResult } from "./commands.js";
export interface TeamflowService {
  snapshot(scope: BackendScope): Promise<TeamflowSnapshot>;
  apply(envelope: MutationEnvelope, actor: ActorContext): Promise<MutationResult>;
}
export interface MemberLaunch {
  scope: BackendScope; runId: string; memberId: string; parentMemberId?: string; role: string; brief: string;
  model?: ModelRef;
  requireExactModel?: boolean;
  writes?: boolean;
  allowDefaultAgentFallback?: boolean;
  sessionId?: string; taskId?: string; dispatchId?: string;
}
export interface MemberDelivery { messageId: string; sessionId: string; text: string; source: string; intent: "queue" | "steer"; resume?: boolean }
export interface MemberSession { sessionId: string; execution: unknown; model?: ModelRef }
