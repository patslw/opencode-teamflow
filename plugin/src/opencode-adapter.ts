import type { Plugin } from "@opencode/plugin";
import { OpenCode, type OpenCodeClient } from "@opencode/client";
import { Service } from "@opencode/client/service";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { BackendScope, MemberDelivery, MemberLaunch, MemberSession, Run, Task, TeamflowMessage } from "../../packages/protocol/src/index.js";
import { discussionPermissions, teamflowToolInstructions } from "./tool-contract.js";

export class DispatchNotSentError extends Error {}
export interface DispatchInspection {
  sessionId: string; exists: boolean; busy: boolean;
  message: "absent" | "queued" | "delivered"; inboxIds: string[]; evidence: string[];
}

export class OpenCodeAdapter {
  private client?: Promise<OpenCodeClient>;
  constructor(private readonly ctx: Plugin.Context, private readonly parentSession: (memberId: string) => string | undefined) {}
  private nativeClient() {
    // Use the official authenticated HTTP API for inbox and archiving. Prove
    // discovery resolved this exact backend process before any access.
    if (this.client) return this.client;
    const initialization = (async () => {
      const file = this.ctx.options.nativeConnectionFile;
      const endpoint = typeof file === "string"
        ? z.object({ url: z.string().url(), auth: z.object({ type: z.literal("basic"), username: z.string(), password: z.string().min(1) }).strict() }).strict().parse(JSON.parse(await readFile(file, "utf8")))
        : await Service.discover();
      if (!endpoint) throw new Error("Native session API unavailable: no registered backend");
      const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) });
      if ((await client.server.info()).pid !== process.pid) throw new Error("Native session API endpoint is not this backend process");
      return client;
    })();
    this.client = initialization;
    // Clear only this failed initialization, never a newer cached instance.
    void initialization.catch(() => { if (this.client === initialization) this.client = undefined; });
    return initialization;
  }

  async assertMainSession(scope: BackendScope, sessionId: string) {
    const session = await this.ctx.session.get({ sessionID: sessionId });
    if (session.location.directory !== scope.projectDirectory || session.parentID || session.time.archived || session.metadata?.teamflow) {
      throw new Error("Use an active top-level user session in the current project as the Teamflow main session");
    }
  }

  async designerModel(role: string): Promise<MemberLaunch["model"]> {
    const selected = (await this.ctx.agent.get({ agentID: role })).data.model;
    return selected ? { providerID: selected.providerID, id: selected.id } : undefined;
  }

  async ensureRunEntry(scope: BackendScope, run: Run & { entry: NonNullable<Run["entry"]> }) {
    const id = run.entry.sessionId;
    // Use the authenticated client for a typed NotFound. No new ID is ever
    // chosen on failure, replay, or scheduler takeover.
    const client = await this.nativeClient();
    const metadata = { teamflow: { kind: "run-entry", runId: run.id } };
    let session;
    try { session = await client.session.get({ sessionID: id }); }
    catch (error) {
      if (!error || typeof error !== "object" || !("_tag" in error) || error._tag !== "SessionNotFoundError") throw error;
      session = await this.ctx.session.create({
        id, title: `Teamflow · ${run.label.replace(/\s+/g, " ").trim().slice(0, 100)} · 团队入口`,
        location: { directory: scope.projectDirectory }, metadata,
        permissions: [{ action: "subagent", resource: "*", effect: "deny" }],
      });
    }
    const tag = session.metadata?.teamflow as Record<string, unknown> | undefined;
    if (session.id !== id || session.parentID || session.location.directory !== scope.projectDirectory || tag?.kind !== "run-entry" || tag.runId !== run.id) {
      throw new Error("Native Teamflow main-session identity mismatch");
    }
    await this.ctx.session.instructions.entry.put({
      sessionID: id, key: "teamflow.entry",
      value: `This is the Teamflow main chat for run ${run.id}. User request:\n${run.brief}\n\nUse teamflow_context to read its real status. ${teamflowToolInstructions} For running, approving, or chatting with members, direct the user to /teamflow (TUI) or the Teamflow web run. Do not impersonate members or launch native subagents for this run.`,
    });
  }

  async createMember(launch: MemberLaunch): Promise<MemberSession> {
    const parentID = launch.parentMemberId ? this.parentSession(launch.parentMemberId) : undefined;
    if (launch.parentMemberId && !parentID) throw new Error("Unknown parent member");
    let model: MemberLaunch["model"];
    let agent = launch.role;
    let client: OpenCodeClient;
    try {
      client = await this.nativeClient();
      if (launch.allowDefaultAgentFallback && !(await this.ctx.agent.list()).data.some(candidate => candidate.id === agent)) agent = "build";
      const configured = (await this.ctx.agent.get({ agentID: agent })).data.model;
      const available = launch.model || (launch.allowDefaultAgentFallback && configured) ? (await this.ctx.model.list()).data : undefined;
      const enabled = (ref: NonNullable<typeof configured>) => available?.some(m => m.enabled && m.providerID === ref.providerID && m.id === ref.id);
      if (launch.model && !enabled(launch.model)) throw new Error("Configured role model is not available on this backend");
      const selected = launch.model ?? (launch.allowDefaultAgentFallback && configured && enabled(configured) ? configured : (await this.ctx.model.default()).data);
      if (!selected) throw new Error("No default model available");
      model = { providerID: selected.providerID, id: selected.id };
    } catch (error) { throw new DispatchNotSentError(error instanceof Error ? error.message || error.name : "Member preflight failed before session.create"); }
    const identity = { kind: "private", memberId: launch.memberId, runId: launch.runId, ...(launch.parentMemberId ? { parentMemberId: launch.parentMemberId } : {}), ...(launch.taskId ? { taskId: launch.taskId } : {}), ...(launch.dispatchId ? { dispatchId: launch.dispatchId } : {}) };
    const session = await this.ctx.session.create({
      ...(launch.sessionId ? { id: launch.sessionId } : {}),
      title: `Teamflow ${launch.memberId}: ${launch.brief.slice(0, 80)}`,
      agent,
      model: { providerID: model.providerID, id: model.id },
      // Logical, registered parent only. Native parentID automatically resumes the
      // parent on completion without a scheduler admission hook in SDK 2.3.0.
      // Never enable that unmetered execution path.
      location: { directory: launch.scope.projectDirectory },
      metadata: { teamflow: identity },
      // Native 2.3.2 filters the Code Mode catalog using each tool's effective
      // permission action before running model hooks. Leave execute enabled,
      // allow only the read tools and our effective IDs, and deny e.g. webfetch.
      permissions: launch.discussionOnly ? [
        { action: "*", resource: "*", effect: "deny" },
        ...discussionPermissions.map(action => ({ action, resource: "*", effect: "allow" as const })),
      ] : [
        { action: "subagent", resource: "*", effect: "deny" },
        ...(launch.writes === false ? [{ action: "edit", resource: "*", effect: "deny" as const }] : []),
        ...(launch.parentMemberId || launch.allowDefaultAgentFallback && launch.writes === false ? [{ action: "shell", resource: "*", effect: "deny" as const }] : []),
      ],
    });
    // Only the positively identified result of this exact new creation may be
    // archived here. No list scans, no retroactive changes to old sessions.
    const tag = session.metadata?.teamflow as Record<string, unknown> | undefined;
    if ((launch.sessionId && session.id !== launch.sessionId) || session.parentID || session.location.directory !== launch.scope.projectDirectory ||
      !Object.entries(identity).every(([key, value]) => tag?.[key] === value)) throw new Error("New private Teamflow session identity mismatch; not archived");
    // 2.3.2's plugin SessionDomain.update accepts the field in its type, but
    // does not archive at runtime. The native HTTP PATCH does; verify by GET.
    await client.session.update({ sessionID: session.id, archived: true });
    if (!(await client.session.get({ sessionID: session.id })).time.archived) throw new Error("New private Teamflow session is not archived; no dispatch or design prompt admitted");
    // The brief is an instruction entry, not a fabricated conversation or an implicit agent start.
    // Preserve even a partially configured real session for explicit reconciliation.
    await this.ctx.session.instructions.entry.put({ sessionID: session.id, key: "teamflow.task", value: launch.brief });
    return { sessionId: session.id, execution: { time: session.time, outcome: session.outcome } };
  }

  async deliver(delivery: MemberDelivery) {
    if (!delivery.messageId.startsWith("msg_")) throw new DispatchNotSentError("Native message ID must start with msg_; no admission attempted");
    const admitted = await this.ctx.session.synthetic({
      sessionID: delivery.sessionId, id: delivery.messageId,
      text: `[Teamflow source: ${delivery.source}]\n${delivery.text}`,
      description: "Teamflow delivery", metadata: { teamflowSource: delivery.source },
       delivery: delivery.intent, resume: delivery.resume ?? true,
    });
    if (admitted.id !== delivery.messageId || admitted.sessionID !== delivery.sessionId) throw new Error("Native admission receipt identity mismatch; inspect, never retry blindly");
    return admitted;
  }
  interrupt(sessionId: string) { return this.ctx.session.interrupt({ sessionID: sessionId, resume: false }); }
  async getSession(sessionId: string): Promise<MemberSession> {
    const session = await this.ctx.session.get({ sessionID: sessionId });
    return { sessionId: session.id, execution: { time: session.time, outcome: session.outcome } };
  }
  async listMessages(sessionId: string) {
    // Native context may return [] for an absent ID. Prove existence first and
    // preserve the ORIGINAL ID/error; never turn NotFound into empty success.
    try {
      await this.ctx.session.get({ sessionID: sessionId });
      return await this.ctx.session.context({ sessionID: sessionId });
    } catch (error) {
      const reason = error instanceof Error ? error.message : JSON.stringify(error);
      throw new Error(`Original native session ${sessionId} unavailable: ${reason}`);
    }
  }
  async hasObservedMessage(sessionId: string, messageId: string, request: { source: string; text: string }) {
    const message = (await this.listMessages(sessionId)).find(m => m.id === messageId);
    if (!message) return false;
    if (message.type !== "synthetic" || message.text !== `[Teamflow source: ${request.source}]\n${request.text}`) {
      throw new Error("Native answer does not match its durable admission intent");
    }
    return true;
  }
  async inspectCollaboration(scope: BackendScope, task: Task, message: TeamflowMessage) {
    const native = await this.inspectDispatch(scope, task);
    if (!native.exists) return { ...native, message: "absent" as const };
    const client = await this.nativeClient();
    const queued = (await client.session.inbox.list({ sessionID: native.sessionId })).find(x => x.id === message.id);
    const delivered = (await this.listMessages(native.sessionId)).find(x => x.id === message.id);
    if (queued && queued.type !== "synthetic" || delivered && delivered.type !== "synthetic") throw new Error("Collaboration ID has a different native type");
    const text = queued?.type === "synthetic" ? queued.payload.text : delivered?.type === "synthetic" ? delivered.text : undefined;
    if (text && message.request && text !== `[Teamflow source: ${message.request.source}]\n${message.request.text}`) throw new Error("Native collaboration content differs from durable intent");
    return { ...native, message: queued ? "queued" as const : delivered ? "delivered" as const : "absent" as const,
      evidence: [...native.evidence, `collaboration ${message.id}: ${queued ? "queued" : delivered ? "delivered" : "absent"}; ${text && message.request ? "exact durable content matched" : text ? "legacy ID observed (no canonical request text stored)" : "no matching native content; absence is not no-send proof"}`] };
  }
  async cancelQueuedCollaboration(sessionId: string, messageIds: string[]) {
    const client = await this.nativeClient();
    const cancelled: string[] = [];
    for (const item of await client.session.inbox.list({ sessionID: sessionId })) {
      if (item.type !== "synthetic" || !messageIds.includes(item.id)) continue;
      await client.session.inbox.cancel({ sessionID: sessionId, inboxID: item.id });
      cancelled.push(item.id);
    }
    return cancelled;
  }
  async inspectDispatch(scope: BackendScope, task: Task, candidate?: string): Promise<DispatchInspection> {
    let sessionId = candidate ?? task.sessionId ?? task.dispatch?.sessionId;
    const client = await this.nativeClient();
    // Legacy unknown creations lack a planned ID. A user-supplied nonexistent ID
    // is not evidence of absence: exhaustively discover by native member metadata.
    if (!task.dispatch && !task.sessionId) {
      const matches = new Set<string>();
      for (const archived of [false, true]) {
        let cursor: string | undefined;
        const seen = new Set<string>();
        do {
          const page = await client.session.list({ directory: scope.projectDirectory, archived, limit: 100, ...(cursor ? { cursor } : {}) });
          for (const session of page.data) {
            const tag = session.metadata?.teamflow as Record<string, unknown> | undefined;
            if (session.location.directory === scope.projectDirectory && tag?.memberId === task.memberId && tag.runId === task.runId) matches.add(session.id);
          }
          cursor = page.cursor.next ?? undefined;
          if (cursor && seen.has(cursor)) throw new Error("Native session discovery incomplete: repeated cursor");
          if (cursor) seen.add(cursor);
        } while (cursor);
      }
      if (matches.size > 1) throw new Error(`Multiple native sessions match legacy dispatch; inspect all before recovery: ${[...matches].join(",")}`);
      const found = [...matches][0];
      if (candidate && found && candidate !== found) throw new Error("Candidate differs from native metadata discovery");
      if (!found) return { sessionId: candidate ?? `unbound:${task.id}`, exists: false, busy: false, message: "absent", inboxIds: [], evidence: ["Complete active+archived native session discovery: no matching member/run/directory"] };
      sessionId = found;
    }
    if (!sessionId) throw new Error("Need the actual native session ID; unknown creation cannot be cleared by a checkbox");
    if (task.dispatch && sessionId !== task.dispatch.sessionId) throw new Error("Session differs from durable planned native ID");
    if (task.sessionId && sessionId !== task.sessionId) throw new Error("Session differs from the bound native ID");
    let session;
    try { session = await client.session.get({ sessionID: sessionId }); }
    catch (error) {
      if (error && typeof error === "object" && "_tag" in error && error._tag === "SessionNotFoundError") {
        return { sessionId, exists: false, busy: false, message: "absent", inboxIds: [], evidence: [`native session.get(${sessionId}): SessionNotFoundError`] };
      }
      throw error;
    }
    const metadata = session.metadata?.teamflow as Record<string, unknown> | undefined;
    if (session.location.directory !== scope.projectDirectory || metadata?.memberId !== task.memberId || metadata?.runId !== task.runId ||
      (task.dispatch && (metadata.taskId !== task.id || metadata.dispatchId !== task.dispatchId))) throw new Error("Native session location / Teamflow identity does not match this dispatch");
    const inbox = await client.session.inbox.list({ sessionID: sessionId });
    const messages = await client.session.context({ sessionID: sessionId });
    const shells = (await client.shell.list({ location: { directory: scope.projectDirectory } })).data.filter(shell => shell.status === "running");
    const activeTools = messages.filter(m => m.type === "assistant" && m.content.some(part => part.type === "tool" && ["running", "streaming"].includes(part.state.status)));
    // These native reads aren't one transaction. In particular, an admitted
    // queue can be consumed between the first time read and inbox.list. Fence the
    // entire observation with a second execution-time sample, not an old idle.
    const after = await client.session.get({ sessionID: sessionId });
    if (after.location.directory !== session.location.directory || JSON.stringify(after.metadata?.teamflow) !== JSON.stringify(session.metadata?.teamflow)) throw new Error("Native identity/location changed during safety observation");
    const executionChanged = after.time.busy !== session.time.busy || after.time.idle !== session.time.idle;
    const queued = inbox.find(m => m.id === task.dispatchId);
    const delivered = messages.find(m => m.id === task.dispatchId);
    if (queued && queued.type !== "synthetic" || delivered && delivered.type !== "synthetic") throw new Error("Native dispatch ID belongs to a different message type");
    const text = queued?.type === "synthetic" ? queued.payload.text : delivered?.type === "synthetic" ? delivered.text : undefined;
    if (text && task.dispatch?.brief && text !== `[Teamflow source: workflow scheduler (not user approval)]\n${task.dispatch.brief}`) throw new Error("Native dispatch content does not match durable brief");
    // Native background shells can outlive model idle/interruption. Do not infer
    // writer safety from Session.time alone; unknown same-location jobs block.
    const busy = executionChanged || (after.time.busy ?? 0) > (after.time.idle ?? 0) || shells.length > 0 || activeTools.length > 0;
    return {
      sessionId, exists: true, busy, message: queued ? "queued" : delivered ? "delivered" : "absent", inboxIds: inbox.map(m => m.id),
      evidence: [`native identity matched ${sessionId} member=${task.memberId} run=${task.runId}`, `native time before=${JSON.stringify(session.time)} after=${JSON.stringify(after.time)} executionChanged=${executionChanged} outcome=${after.outcome ?? "none"}`, `dispatch=${task.dispatchId} ${queued ? "queued" : delivered ? "delivered" : "absent"}; inbox=${inbox.map(m => m.id).join(",")}`, `native running shell IDs=${shells.map(s => s.id).join(",")}; active tool messages=${activeTools.length}`],
    };
  }
  async prepareBound(sessionId: string, brief: string) {
    const session = await (await this.nativeClient()).session.get({ sessionID: sessionId });
    const tag = session.metadata?.teamflow as Record<string, unknown> | undefined;
    if (tag?.kind === "private" && !session.time.archived) throw new Error("Private Teamflow session was not archived; no recovery dispatch admitted");
    await this.ctx.session.instructions.entry.put({ sessionID: sessionId, key: "teamflow.task", value: brief });
  }
  async stopDispatch(scope: BackendScope, task: Task, candidate?: string) {
    const before = await this.inspectDispatch(scope, task, candidate);
    if (!before.exists) return before;
    if (before.message === "queued") await (await this.nativeClient()).session.inbox.cancel({ sessionID: before.sessionId, inboxID: task.dispatchId });
    await this.interrupt(before.sessionId);
    return this.inspectDispatch(scope, task, before.sessionId);
  }
}
