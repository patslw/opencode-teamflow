import { MutationEnvelopeSchema, MutationResultSchema, type BackendScope, type MutationEnvelope, type MutationResult, type TeamflowCommand } from "../../packages/protocol/src/index.js";

// Client-side transport journal, not workflow state. Save BEFORE sending so a
// lost response/reloaded client can only replay the original idempotent request.
export class MutationRejectedError extends Error {}
export class MutationRetry {
  private active = false;
  private value: MutationEnvelope | undefined;
  constructor(
    private readonly scope: BackendScope,
    private readonly send: (envelope: MutationEnvelope) => Promise<MutationResult>,
    initial: MutationEnvelope | undefined,
    private readonly save: (envelope: MutationEnvelope | undefined, expectedRequestId: string) => Promise<void> | void,
  ) {
    if (initial) {
      this.value = MutationEnvelopeSchema.parse(initial);
      this.assertScope(this.value.scope);
    }
  }
  get pending() { return this.value; }
  private assertScope(scope: BackendScope) {
    if (scope.backendId !== this.scope.backendId || scope.projectDirectory !== this.scope.projectDirectory) throw new Error("未决操作的后端/项目身份不匹配");
  }
  async submit(revision: number, command: TeamflowCommand) {
    if (this.value || this.active) throw new Error("存在未决操作；请先按原身份核对/重试，或明确处理后再发起新操作");
    const envelope = MutationEnvelopeSchema.parse({ scope: this.scope, expectedRevision: revision, requestId: crypto.randomUUID(), command });
    // A storage failure here is definitely before transmission.
    this.active = true;
    this.value = envelope;
    try { await this.save(envelope, envelope.requestId); }
    catch (error) { this.value = undefined; throw error; }
    finally { this.active = false; }
    return this.retry();
  }
  async retry() {
    if (this.active) throw new Error("原请求正在发送，请勿并发重试");
    if (!this.value) throw new Error("没有未决操作");
    const envelope = this.value;
    this.active = true;
    try {
      let result: MutationResult;
      try {
        result = MutationResultSchema.parse(await this.send(structuredClone(envelope)));
        this.assertScope(result.snapshot.scope);
      } catch (error) {
        // Only an explicit typed business rejection proves non-commit.
        if (error instanceof MutationRejectedError ||
          (typeof error === "object" && error !== null && "type" in error && error.type === "rejected")) {
          await this.save(undefined, envelope.requestId);
          this.value = undefined;
          throw new MutationRejectedError(error instanceof Error ? error.message : JSON.stringify(error));
        }
        throw error;
      }
      if (result.inProgress?.reason !== "request_in_progress") {
        // Another task request did NOT accept or queue our command.
        await this.save(undefined, envelope.requestId);
        this.value = undefined;
      }
      return result;
    } finally { this.active = false; }
  }
  async forget() {
    if (this.active) throw new Error("请求正在发送，不能放弃跟踪");
    if (!this.value) throw new Error("没有未决操作");
    await this.save(undefined, this.value.requestId);
    this.value = undefined;
  }
}
