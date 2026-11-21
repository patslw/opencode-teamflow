import type { BackendScope, Run, Task, TeamflowSnapshot } from "../../packages/protocol/src/index.js";
import { DispatchNotSentError, type OpenCodeAdapter } from "./opencode-adapter.js";
import type { TeamflowStore } from "./store.js";
import { advance, audit, attemptVersion, current, now, sourceDelivery, uid } from "./engine.js";
import { backendProcessIdentity, bindNativeSession, leaderKey, writerKey } from "./dispatch.js";
import { settleCorrections, settleTopics } from "./collaboration.js";
import { pumpCollaboration } from "./collaboration-dispatch.js";
import { reconcileExecutions } from "./execution-reconcile.js";
import { bumpIO, recoveryBlocks } from "./execution-fence.js";
import { patchBlocks, settlePatches } from "./patches.js";
import { isDiscussion } from "./questions.js";
import { teamConversationId } from "./templates/team-conversation.js";
import { teamflowToolInstructions } from "./tool-contract.js";
import { taskCapabilities } from "./stage-capabilities.js";
import { plannedModel } from "./model-routing.js";

export { writerKey } from "./dispatch.js";
// Shared by deferred selection and the final atomic native authorization.
function initialRunEligible(run: Run, task: Task) {
  return run.entry?.state !== "pending" && (run.status === "running" || run.status === "waiting" && !!task.child && !task.child.staleBy);
}
export class Scheduler {
  readonly owner = uid();
  private busy = false;
  private stopped = false;
  private fenced = false;
  private readonly entryRetryAt = new Map<string, number>();
  constructor(private store: TeamflowStore, private adapter: OpenCodeAdapter, private scope: BackendScope, private changed: (s: TeamflowSnapshot) => Promise<void>) {}
  stop() { this.stopped = true; }
  private hasLeadership() { return !this.stopped && !this.fenced && this.store.owns(leaderKey(this.scope), this.owner); }
  private commit(change: (s: TeamflowSnapshot) => void, requireLeader = true) {
    return this.store.transact(this.scope, s => {
      if (requireLeader && !this.hasLeadership()) throw new Error("Scheduler fenced: leadership expired or transferred");
      change(s); s.revision++; return structuredClone(s);
    });
  }
  private async announce(s: TeamflowSnapshot) { try { await this.changed(s); } catch { /* committed state wins */ } }
  private async prepareRunEntry() {
    const run = this.store.read(this.scope).runs.find(r => r.entry?.state === "pending" &&
      !["cancelled", "failed"].includes(r.status) && (this.entryRetryAt.get(r.id) ?? 0) <= Date.now());
    if (!run?.entry || !this.hasLeadership()) return;
    const entry = run.entry;
    let error: string | undefined;
    try { await this.adapter.ensureRunEntry(this.scope, { ...run, entry }); }
    catch (cause) { error = cause instanceof Error ? cause.message || cause.name : String(cause); }
    if (error) this.entryRetryAt.set(run.id, Date.now() + 10000);
    else this.entryRetryAt.delete(run.id);
    if (!this.hasLeadership() || (error && error === entry.error)) return;
    await this.announce(this.commit(s => {
      const current = s.runs.find(r => r.id === run.id)?.entry;
      if (current?.sessionId !== entry.sessionId || current.state !== "pending") throw new Error("Main-session reservation changed");
      if (error) current.error = error;
      else { current.state = "ready"; delete current.error; }
      audit(s, error ? "run.entry_waiting" : "run.entry_ready", { kind: "system" }, JSON.stringify({ runId: run.id, sessionId: entry.sessionId, error }));
    }));
  }
  private async waitForReceipt(taskId: string, receipt: Promise<void>) {
    // Do not let a lost/cancelled native request monopolize this scheduler loop.
    // Its receipt handler stays attached and records the actual late outcome, but
    // the abandoned continuation can NEVER authorize another native operation.
    let timer: ReturnType<typeof setInterval> | undefined;
    const fenced = new Promise<boolean>(resolve => {
      timer = setInterval(() => {
        try {
          const t = this.store.read(this.scope).tasks.find(t => t.id === taskId);
          if (!this.hasLeadership() || !t || t.owner !== this.owner || ["cancelled", "superseded"].includes(t.status)) resolve(false);
        } catch { resolve(false); }
      }, 500);
    });
    try {
      const completed = await Promise.race([receipt.then(() => true), fenced]);
      if (!completed && !this.hasLeadership()) await this.announce(this.commit(s => {
        const t = s.tasks.find(t => t.id === taskId);
        if (t?.owner === this.owner && ["intent", "bound"].includes(t.status)) {
          t.owner = `orphan:${uid()}`; t.status = "uncertain";
          t.error = "Native creation continuation fenced; reconcile the planned session, never repeat creation";
          audit(s, "dispatch.continuation_fenced", { kind: "system" }, taskId);
        }
      }, false));
      return completed;
    }
    finally { if (timer) clearInterval(timer); }
  }
  private async deliverBound(taskId: string) {
    const authorized = this.store.transact(this.scope, s => {
      if (!this.hasLeadership()) return;
      const t = s.tasks.find(t => t.id === taskId)!;
      const run = s.runs.find(r => r.id === t.runId)!;
      const a = s.attempts.find(a => a.id === t.attemptId)!;
      if (patchBlocks(s, run.id, a.nodeId) || recoveryBlocks(t) || this.store.pendingRequestForTask(this.scope, t.id) || t.owner !== this.owner || t.status !== "bound" || !t.sessionId || !t.dispatch?.brief ||
        t.writes && !this.store.owns(writerKey(this.scope), t.id) ||
        !["not_started", "not_sent"].includes(t.dispatch.delivery) || !initialRunEligible(run, t) ||
        current(s, run.id, a.nodeId)?.id !== a.id || (!t.child && a.status !== "running")) return;
      t.status = "running"; t.dispatch.delivery = "pending"; t.dispatch.process = backendProcessIdentity; bumpIO(t);
      s.revision++; audit(s, "dispatch.delivery_intent", { kind: "system" }, t.dispatchId);
      return { task: structuredClone(t), snapshot: structuredClone(s) };
    });
    if (!authorized) return;
    const { task } = authorized;
    // No await/notification between the fenced transaction and starting this ONE call.
    const receipt = (async () => {
      try {
        const admission = this.adapter.deliver({ messageId: task.dispatchId, sessionId: task.sessionId!, source: "workflow scheduler (not user approval)", intent: "queue", text: task.dispatch!.brief });
        await this.announce(authorized.snapshot);
        await admission;
        await this.announce(this.commit(s => {
          const t = s.tasks.find(t => t.id === taskId)!;
          if (t.dispatch!.delivery !== "terminated") t.dispatch!.delivery = "admitted";
          bumpIO(t);
          // Receipt is historical fact, not permission to revive a cancelled/fenced task.
          audit(s, "dispatch.admitted", { kind: "system" }, task.dispatchId);
        }, false));
      } catch (error) { await this.recordFailure(taskId, "delivery", error); }
    })();
    await this.waitForReceipt(taskId, receipt);
  }
  private async recordFailure(taskId: string, phase: "create" | "delivery", error: unknown) {
    await this.announce(this.commit(s => {
      const t = s.tasks.find(t => t.id === taskId)!;
      bumpIO(t);
      const strongerDeliveryProof = phase === "delivery" && t.dispatch && ["admitted", "terminated"].includes(t.dispatch.delivery);
      if (t.dispatch && !strongerDeliveryProof) t.dispatch[phase] = error instanceof DispatchNotSentError ? "not_sent" : "failed";
      const message = error instanceof Error ? error.message : "Unconfirmed native request";
      if (!strongerDeliveryProof && t.owner === this.owner && !["submitted", "superseded", "cancelled"].includes(t.status)) { t.status = "uncertain"; t.error = message; }
      audit(s, "dispatch.request_settled", { kind: "system" }, JSON.stringify({ taskId, phase, owner: this.owner, result: t.dispatch?.[phase], message }));
    }, false));
  }
  async tick() {
    if (this.busy || this.stopped) return;
    this.busy = true;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    try {
      if (!this.store.acquire(leaderKey(this.scope), this.owner, Date.now() + 15000)) return;
      this.fenced = false;
      heartbeat = setInterval(() => {
        // Renewal can NEVER reacquire an expired/transferred lease.
        try {
          if (!this.stopped && !this.store.renew(leaderKey(this.scope), this.owner, Date.now() + 15000)) this.fenced = true;
        } catch { this.fenced = true; }
      }, 3000);
      const execution = { store: this.store, adapter: this.adapter, scope: this.scope, owner: this.owner,
        leader: () => this.hasLeadership(), announce: (s: TeamflowSnapshot) => this.announce(s) };
      await this.prepareRunEntry();
      await pumpCollaboration(execution);
      await reconcileExecutions(execution);
      // Claim intent inside the same SQLite write transaction as slot and writer lease.
      let claimed: Task | undefined;
      const updated = this.store.transact(this.scope, s => {
        if (!this.hasLeadership()) return;
        const initialRevision = s.revision;
        const beforeCorrections = s.corrections.filter(c => c.status === "applied").length;
        const beforeTopics = s.topics.filter(t => t.status === "escalated").length;
        settleTopics(s);
         settleCorrections(s, this.store);
          const beforePatches = JSON.stringify(s.patches);
         settlePatches(s, this.store);
          if (JSON.stringify(s.patches) !== beforePatches) { advance(s); s.revision++; }
        if (s.corrections.filter(c => c.status === "applied").length !== beforeCorrections || s.topics.filter(t => t.status === "escalated").length !== beforeTopics) { advance(s); s.revision++; }
        for (const t of s.tasks.filter(t => t.child && t.status === "intent" && !t.slotHeld && t.owner === "collaboration:queued")) {
          if (!["completed", "cancelled", "failed"].includes(s.runs.find(r => r.id === t.runId)!.status)) continue;
          t.status = "cancelled"; t.error = "Workflow became terminal before auxiliary claim; never silently leave accepted work queued";
          s.revision++; audit(s, "child.queue_cancelled", { kind: "system" }, t.id);
        }
        const recovered = s.tasks.find(t => t.status === "bound" && t.reconciliation?.action === "bind" && t.reconciliation.state === "ready" && s.runs.find(r => r.id === t.runId)?.status === "running");
        if (recovered) {
          recovered.owner = this.owner; recovered.reconciliation!.state = "bound";
          claimed = structuredClone(recovered); s.revision++;
          audit(s, "dispatch.recovery_claimed", { kind: "system" }, recovered.id);
          return structuredClone(s);
        }
        // An inspection reservation may have temporarily deferred deliverBound
        // after native creation. Retry the same never-issued dispatch, without
        // transferring ownership or creating another session.
        const deferred = s.tasks.find(t => {
          const run = s.runs.find(r => r.id === t.runId), a = s.attempts.find(a => a.id === t.attemptId);
          return t.owner === this.owner && t.status === "bound" && t.sessionId && t.dispatch?.brief &&
            !recoveryBlocks(t) && !this.store.pendingRequestForTask(this.scope, t.id) &&
            ["not_started", "not_sent"].includes(t.dispatch.delivery) && run && initialRunEligible(run, t) &&
            a && current(s, run.id, a.nodeId)?.id === a.id && (t.child || a.status === "running") &&
            (!t.writes || this.store.owns(writerKey(this.scope), t.id));
        });
        if (deferred) { claimed = structuredClone(deferred); return structuredClone(s); }
        for (const run of s.runs.filter(r => r.entry?.state !== "pending" && ["running", "waiting"].includes(r.status))) {
          if (s.tasks.filter(t => t.runId === run.id && t.slotHeld).length >= run.config.activeSlots) continue;
          const child = s.tasks.find(t => t.runId === run.id && t.child && !t.slotHeld && t.status === "intent" && t.owner === "collaboration:queued");
          if (child) {
            const parent = s.members.find(m => m.id === child.child!.parentMemberId)!;
            const parentTask = s.tasks.find(t => t.id === parent.taskId)!;
            const basis = s.attempts.find(a => a.id === child.attemptId)!;
            if (child.child!.staleBy || basis.supersededBy || !["running", "submitted"].includes(parentTask.status) ||
              !["running", "passed"].includes(basis.status) || current(s, run.id, basis.nodeId)?.id !== child.attemptId) { child.status = "cancelled"; child.error = "Queued auxiliary basis became inactive/stale before execution"; s.revision++; continue; }
            child.slotHeld = true; child.owner = this.owner; claimed = structuredClone(child);
            s.revision++; audit(s, "child.dispatch_intent", { kind: "system" }, child.id);
            return structuredClone(s);
          }
          for (const a of s.attempts.filter(a => run.status === "running" && a.runId === run.id && a.status === "ready")) {
            if (patchBlocks(s, run.id, a.nodeId)) continue;
             const version = attemptVersion(s, a);
             const n = version.graph.nodes.find(n => n.id === a.nodeId)!;
             const modelPlan = version.roles.find(r => r.id === n.role)?.model ? undefined : plannedModel(run, a, version.id);
            const taskId = uid();
            if (n.writes && !this.store.acquire(writerKey(this.scope), taskId)) continue;
            claimed = { id: taskId, runId: run.id, attemptId: a.id, memberId: `member-${uid()}`, writes: n.writes, status: "intent", dispatchId: `msg_${uid().replaceAll("-", "")}`, slotHeld: true, owner: this.owner, createdAt: now(),
               dispatch: { sessionId: `ses_${uid().replaceAll("-", "")}`, brief: "", role: n.role!, create: "not_started", delivery: "not_started", process: backendProcessIdentity,
                 ...(modelPlan ? { modelPlan: structuredClone(modelPlan) } : {}) } };
            s.tasks.push(claimed); a.status = "running";
            s.revision++; audit(s, "dispatch.intent", { kind: "system" }, `${claimed.id} attempt=${a.id}`);
            return structuredClone(s);
          }
        }
        return s.revision !== initialRevision ? structuredClone(s) : undefined;
      });
      if (!claimed || !updated || this.stopped) { if (updated) await this.announce(updated); return; }
      await this.announce(updated);
      if (claimed.sessionId) { await this.deliverBound(claimed.id); return; }
      const task = claimed, run = updated.runs.find(r => r.id === task.runId)!;
      const a = updated.attempts.find(a => a.id === task.attemptId)!;
      const executionVersion = attemptVersion(updated, a);
      const n = executionVersion.graph.nodes.find(n => n.id === a.nodeId)!;
      const role = executionVersion.roles.find(r => r.id === (task.child?.role ?? n.role))!;
      const d = n.sourceNodeId ? sourceDelivery(updated, run, n) : undefined;
      const predecessors = executionVersion.graph.edges.filter(e => e.to === n.id && e.kind === "normal").map(e => current(updated, run.id, e.from));
      const conversationTemplate = executionVersion.templateId === teamConversationId;
      const discussion = isDiscussion(updated, a.id);
      const proposal = conversationTemplate && !discussion ? current(updated, run.id, executionVersion.graph.entry) : undefined;
      const inputs = updated.deliveries.filter(d => !d.staleBy && (d.attemptId === proposal?.id || predecessors.some(a => a?.id === d.attemptId)));
      const submission = n.kind === "work"
        ? { type: "task.submit", payload: { taskId: task.id, attemptId: a.id, artifactRevision: "<actual artifact version/hash>", criteriaRevision: a.criteriaRevision, artifacts: ["<real artifact path/ref>"], summary: "<actual results>", checks: [], unresolved: [] } }
        : { type: "review.submit", payload: { attemptId: a.id, targetAttemptId: d!.attemptId, deliveryId: d!.id, artifactRevision: d!.artifactRevision, criteriaRevision: d!.criteriaRevision, verdict: "pass|needs_revision|reject", issues: [], evidence: [] } };
      const brief = task.child ? [
        `Teamflow tracked auxiliary child. Run ${run.id}; member ${task.memberId}; logical parent ${task.child.parentMemberId}. Fresh independent session, NOT native parentID (unmetered auto-wake disabled).`,
        `Role ${role.id}: ${role.responsibility}\n${role.prompt}`,
        teamflowToolInstructions,
        `Only relevant task input:\n${task.child.brief}`,
        `Read-only. Never use native subagent. Only teamflow_command member.spawn is tracked; max depth ${run.config.childDepth}. No user approval.`,
        `Basis ${task.child.criteriaRevision ?? a.criteriaRevision}: ${task.child.requirements ?? a.requirements ?? "original brief"}; topic=${task.child.topicId ?? "explicit unrelated work"}.`,
        "If a business ambiguity materially affects your findings, use teamflow_command question.ask and end this turn. The user answer returns to this same session and does not approve anything.",
        `Finish via ${JSON.stringify({ type: "member.finish", payload: { taskId: task.id, summary: "<actual findings>" } })}. Parent result is returned through scheduler-admitted same-session continuation, never an unmetered native parent wake.`,
      ].join("\n\n") : [
        `Teamflow real product execution. Run ${run.id} (${run.label}); directory ${this.scope.projectDirectory}.`,
        `User task: ${run.brief}`, `Role ${role.id}: ${role.responsibility}\n${role.prompt}`, `Node ${n.id}; mode=${n.mode}; writes=${n.writes}; ${n.prompt}`,
        `Criteria ${a.criteriaRevision}: ${n.criteria.join("; ")}.`,
        `Current requirements: ${a.requirements ?? "original node criteria"}.
Registered peers (not transcripts): ${JSON.stringify(updated.members.filter(m => m.runId === run.id).map(m => ({ id: m.id, role: m.role })))}.`,
        `Rework context: ${a.reason ?? "initial attempt"}`,
        `Inputs: ${JSON.stringify(inputs)}\nSource delivery: ${JSON.stringify(d ?? null)}`,
        teamflowToolInstructions,
        ...(!task.writes && role.id === "coordinator" ? ["For future unclaimed workflow tasks, check teamflow_context for the user's candidate models and targets. If candidates exist, use model.plan to record choices by actual difficulty and specialty, and explain why; a model choice is not dispatch, permission, or approval."] : []),
        ...(proposal ? ["The proposal in Inputs was approved by the user before this task was dispatched. Use its confirmedQuestions and acceptance criteria; do not silently change the scope."] : []),
        ...(discussion ? ["This is a read-only discussion, not implementation. Do not delegate. Ask a focused real user question with question.ask before drafting any submitted plan. Provide 2–4 meaningful options when possible. Wait for a user reply in this session. Ask again if needed. Then summarize the verified answers, proposed scope, exclusions and acceptance in task.submit. Its delivery awaits a separate user decision."] : ["Only teamflow_command member.spawn may create a registered read-only child when role/depth allow."]),
        "Do not implement Teamflow itself. Native subagent is denied. Only do this run's task in its directory. No fake evidence or user approvals.",
        "For genuine task uncertainty, use the tracked Teamflow question and end the turn without submitting. For peer expertise use tracked team messages or agreed topics; never assume an unanswered requirement.",
        "Use the actual teamflow_command tool to submit exactly once, then STOP all file writes and finish your response. A prose answer alone does not complete the task.",
        `Submission shape: ${JSON.stringify(submission)}`,
        "Checks/evidence items: {command:string,exitCode:integer,output:string,version:artifactRevision,source:'self_report' for work or 'independent_execution' for reviews/tests}. Test pass requires real executed evidence; review can pass with inspected artifact refs in summary/issues and optional commands. Never report an unexecuted command.",
        "If tool revision conflicts, retry the same submission via tool (it reads current revision). Never submit another attempt's result. Tools derive identity from your real session.",
      ].join("\n\n");
      try {
        const starting = this.commit(s => {
          const t = s.tasks.find(t => t.id === task.id)!;
          const r = s.runs.find(r => r.id === t.runId)!;
          if (t.owner !== this.owner || t.status !== "intent" || ["cancelled", "failed", "completed"].includes(r.status) || current(s, r.id, a.nodeId)?.id !== a.id) throw new DispatchNotSentError("Create intent fenced/cancelled before native invocation");
          t.dispatch!.brief = brief; t.dispatch!.create = "pending";
          audit(s, "dispatch.create_intent", { kind: "system" }, JSON.stringify({ taskId: t.id, sessionId: t.dispatch!.sessionId, owner: this.owner }));
        });
        // No model starts until the actual session is durably bound.
        const receipt = (async () => {
          try {
             const modelPlan = task.dispatch?.modelPlan;
             const creation = this.adapter.createMember({ scope: this.scope, runId: run.id, memberId: task.memberId, parentMemberId: task.child?.parentMemberId, role: role.agent, brief, model: role.model ?? modelPlan?.model,
               requireExactModel: !!modelPlan, writes: task.writes,
              allowDefaultAgentFallback: conversationTemplate, sessionId: task.dispatch!.sessionId, taskId: task.id, dispatchId: task.dispatchId },
            taskCapabilities(updated, task));
            await this.announce(starting);
            const session = await creation;
            await this.announce(this.commit(s => {
              const t = s.tasks.find(t => t.id === task.id)!;
               bindNativeSession(s, t, session.sessionId); t.dispatch!.create = "succeeded";
               if (session.model) t.dispatch!.nativeModel = session.model;
              if (this.hasLeadership() && t.owner === this.owner && t.status === "intent") t.status = "bound";
              audit(s, "dispatch.bound", { kind: "system" }, `${task.id} session=${session.sessionId} returningOwner=${this.owner} currentOwner=${t.owner}`);
            }, false));
          } catch (error) { await this.recordFailure(task.id, "create", error); }
        })();
        if (!await this.waitForReceipt(task.id, receipt)) return;
      } catch (error) {
        await this.recordFailure(task.id, "create", error); return;
      }
      await this.deliverBound(task.id);
    } finally { if (heartbeat) clearInterval(heartbeat); this.busy = false; }
  }
}
