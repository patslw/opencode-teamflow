import type { ActorContext, TeamflowCommand, TeamflowSnapshot, TeamflowMessage } from "../../packages/protocol/src/index.js";
import { audit, attemptVersion, automaticReturns, current, now, uid, versionFor } from "./engine.js";
import { conversationEligible, recoveryBlocks, unresolvedIO } from "./execution-fence.js";
import { preserveLegacyEscalation, resolutionBasis, resolveEscalation } from "./escalation.js";
import type { TeamflowStore } from "./store.js";
import { assertTopicActor, associationFor, type Association } from "./topic-policy.js";

const nativeId = () => `msg_${uid().replaceAll("-", "")}`;
export function enqueue(s: TeamflowSnapshot, runId: string, from: string, to: string, text: string, extra: Partial<TeamflowMessage> = {}) {
  const m: TeamflowMessage = { id: nativeId(), runId, from, to, text,
    senderKind: s.members.some(m => m.id === from && m.runId === runId) ? "agent" : ["user", "user-correction"].includes(from) ? "user" : "system",
    status: "intent", continuationAuthorized: true, taskId: s.members.find(m => m.id === to && m.runId === runId)?.taskId, createdAt: now(), ...extra };
  s.messages.push(m); return m.id;
}
function memberActor(s: TeamflowSnapshot, actor: ActorContext, runId: string) {
  if (actor.kind !== "agent") throw new Error("Real registered member session required");
  const m = s.members.find(m => m.sessionId === actor.sessionId && m.runId === runId);
  const t = m && s.tasks.find(t => t.id === m.taskId);
  if (!m || !t || !t.slotHeld || !conversationEligible(s, t) || recoveryBlocks(t)) throw new Error("Caller is not an actively leased current member/conversation");
  return m;
}
function liveRun(s: TeamflowSnapshot, id: string) {
  const r = s.runs.find(r => r.id === id);
  if (!r || !["running", "waiting", "paused"].includes(r.status)) throw new Error("Unknown/terminal run");
  return r;
}
function correctableRun(s: TeamflowSnapshot, id: string) {
  const r = s.runs.find(r => r.id === id);
  if (!r || ["cancelled", "failed"].includes(r.status)) throw new Error("Unknown/cancelled/failed run cannot be corrected or revived");
  return r;
}
function sender(s: TeamflowSnapshot, actor: ActorContext, runId: string) {
  return actor.kind === "user" ? "user" : memberActor(s, actor, runId).id;
}
function opinion(s: TeamflowSnapshot, topicId: string, memberId: string, text: string, evidence: string[] = []) {
  assertTopicActor(s, memberId, topicId);
  const t = s.topics.find(t => t.id === topicId);
  if (!t || t.status !== "open") throw new Error("Topic is closed/escalated");
  if (!t.participants.includes(memberId) || t.responses.some(r => r.memberId === memberId && (r.round ?? 1) === t.round)) throw new Error("Only one opinion per registered participant per round; no DM/child budget bypass");
  t.responses.push({ memberId, text, round: t.round, evidence });
  if (!t.participants.every(id => t.responses.some(r => r.memberId === id && (r.round ?? 1) === t.round))) return;
  const round = t.round, exchange = t.responses.filter(r => (r.round ?? 1) === round);
  for (const id of t.participants) enqueue(s, t.runId, "topic-exchange", id,
    `Topic ${t.id}, completed round ${round}: ${JSON.stringify(exchange.filter(r => r.memberId !== id))}. ${round === 3 ? "Budget exhausted: escalate to user. No more topic messages/responses." : "Use topic.respond once for the next round, or propose a conclusion."} No approval implied.`,
    { topicId: t.id, topicRound: round, topicStage: "exchange" });
  if (round === 3) { t.status = "escalated"; t.escalationReason = "Three-round discussion budget exhausted; trusted user decision required"; }
  else t.round++;
}
function communication(s: TeamflowSnapshot, runId: string, from: string, to: string, text: string, p: Association, childResult = false) {
  const a = associationFor(s, runId, from, to, p, childResult);
  if (a.topicId) {
    const t = s.topics.find(t => t.id === a.topicId)!;
    if (t.status !== "open") {
      enqueue(s, runId, from, to, text, { ...a, topicStage: "associated", topicRound: t.round, status: "cancelled", error: "Child completion preserved; closed/escalated topic cannot route further discussion" });
      return;
    }
    if (t.participants.includes(from) && !(childResult && t.responses.some(r => r.memberId === from && (r.round ?? 1) === t.round))) { opinion(s, t.id, from, text); return; }
    // Nonparticipant auxiliary findings are held behind the same first-opinion
    // barrier. They don't impersonate the parent's independent opinion.
    if (!childResult && from !== "user") throw new Error("Nonparticipant relay cannot continue a topic; use registered participants");
    enqueue(s, runId, from, to, text, { ...a, topicStage: "associated", topicRound: t.round });
  } else enqueue(s, runId, from, to, text, a);
}
export function collaborate(s: TeamflowSnapshot, c: TeamflowCommand, actor: ActorContext): boolean {
  switch (c.type) {
    case "member.spawn": {
      const p = c.payload, run = liveRun(s, p.runId);
      if (run.status !== "running") throw new Error("Run must be running to spawn");
      const parent = memberActor(s, actor, run.id);
      if (p.parentMemberId && p.parentMemberId !== parent.id) throw new Error("Cannot impersonate parent");
      if (["user", "user-correction", "topic-exchange"].includes(p.memberId)) throw new Error("Reserved sender identity");
      if (s.members.some(m => m.id === p.memberId) || s.tasks.some(t => t.memberId === p.memberId)) throw new Error("Member ID already registered/reserved");
      const task = s.tasks.find(t => t.id === parent.taskId)!;
      const v = attemptVersion(s, s.attempts.find(a => a.id === task.attemptId)!), parentRole = v.roles.find(r => r.id === parent.role)!, role = v.roles.find(r => r.id === p.role);
      let depth = 1, ancestor = parent;
      while (ancestor.parentMemberId) { depth++; ancestor = s.members.find(m => m.id === ancestor.parentMemberId)!; }
      if (!role || !role.model || !parentRole.childRoles.includes(role.id) || depth > Math.min(run.config.childDepth, parentRole.maxDepth)) throw new Error("Child role/model/depth not permitted");
      // Auxiliary children are read-only. Writers remain ordinary workflow nodes
      // with an independent Gate, never nested writers sharing a parent's lease.
      if (task.executionMode === "conversation" || task.status !== "running") throw new Error("Conversation cannot spawn workflow work against an already submitted attempt");
      const association = associationFor(s, run.id, parent.id, parent.id, p);
      if (s.tasks.filter(t => t.runId === run.id && (t.slotHeld || t.owner === "collaboration:queued" && t.status === "intent")).length >= run.config.activeSlots) throw new Error("Execution/queued child capacity exhausted; no unbounded child queue");
      s.tasks.push({ id: uid(), runId: run.id, attemptId: task.attemptId, memberId: p.memberId, writes: false, status: "intent", dispatchId: nativeId(), slotHeld: false, owner: "collaboration:queued", createdAt: now(),
        child: { parentMemberId: parent.id, role: role.id, brief: p.brief, basisAttemptId: task.attemptId,
          criteriaRevision: s.attempts.find(a => a.id === task.attemptId)!.criteriaRevision,
          requirements: s.attempts.find(a => a.id === task.attemptId)!.requirements, ...association },
        dispatch: { sessionId: `ses_${uid().replaceAll("-", "")}`, brief: "", role: role.agent, create: "not_started", delivery: "not_started" } });
      break;
    }
    case "member.finish": {
      const t = s.tasks.find(t => t.id === c.payload.taskId);
      if (!t?.child || t.status !== "running" || t.child.completedAt || memberActor(s, actor, t.runId).id !== t.memberId) throw new Error("Only active child owner may finish once; completion history is immutable");
      // Completion is a factual history, applicability is a separate field.
      const a = associationFor(s, t.runId, t.memberId, t.child.parentMemberId, c.payload, true);
      if (a.topicId) t.child.topicId = a.topicId; // preserve the explicit result association for later relays
      if (a.topicId && s.topics.find(x => x.id === a.topicId)?.participants.includes(t.memberId)) {
        communication(s, t.runId, t.memberId, t.child.parentMemberId, c.payload.summary, a, true);
      } else communication(s, t.runId, t.memberId, t.child.parentMemberId, `Child result (not approval), criteria ${t.child.criteriaRevision ?? "legacy"}: ${c.payload.summary}`, a, true);
      t.child.result = c.payload.summary; t.child.completedAt = now(); t.status = "submitted"; t.executionMode = "conversation";
      break;
    }
    case "message.send": {
      const p = c.payload; correctableRun(s, p.runId);
      const from = sender(s, actor, p.runId);
      if (!s.members.some(m => m.id === p.toMemberId && m.runId === p.runId)) throw new Error("Recipient is not in this run");
      communication(s, p.runId, from, p.toMemberId, p.text, p); break;
    }
    case "message.ack": {
      const m = s.messages.find(m => m.id === c.payload.messageId);
      if (!m || !["delivered", "acknowledged"].includes(m.status) || memberActor(s, actor, m.runId).id !== m.to || !["observed_inbox", "observed_context"].includes(m.admission ?? "")) throw new Error("Only actual recipient may acknowledge a native-observed, non-cancelled delivered message");
      m.status = "acknowledged"; m.acknowledgedAt = now(); break;
    }
    case "topic.open": {
      const p = c.payload; liveRun(s, p.runId); const from = sender(s, actor, p.runId);
      if (p.sourceTopicId) throw new Error("Do not reopen/relay a known topic as a new question; use its existing bounded route or user resolution");
      if (s.tasks.some(t => t.memberId === from && t.status === "running" && t.child?.topicId)) throw new Error("Active topic-bound child cannot repackage its task findings as another question");
      if (!p.unrelatedReason && s.topics.some(t => t.runId === p.runId && t.status !== "resolved" && (t.participants.includes(from) || p.participantIds.some(id => t.participants.includes(id))))) throw new Error("Classify the new question explicitly with unrelatedReason; no semantic detection of disguised text");
      if (s.topics.some(t => t.id === p.topicId) || new Set(p.participantIds).size !== p.participantIds.length || p.participantIds.length < 2 || p.participantIds.some(id => !s.members.some(m => m.id === id && m.runId === p.runId))) throw new Error("Topic needs unique ID and >=2 registered run participants");
      s.topics.push({ id: p.topicId, runId: p.runId, question: p.question, participants: p.participantIds, unrelatedReason: p.unrelatedReason, relatedTaskIds: s.tasks.filter(t => p.participantIds.includes(t.memberId)).map(t => t.id), round: 1, status: "open", responses: [] });
      for (const id of p.participantIds) enqueue(s, p.runId, from, id, `Topic ${p.topicId}, independent opinion first (round 1): ${p.question}. Use topic.respond. No peer contents until all have responded.`, { topicId: p.topicId, topicRound: 1, topicStage: "question" });
      break;
    }
    case "topic.respond": {
      const p = c.payload, t = s.topics.find(t => t.id === p.topicId);
      if (!t || t.status !== "open") throw new Error("Topic is not open");
      const m = memberActor(s, actor, t.runId);
      opinion(s, t.id, m.id, p.text, p.evidence);
      break;
    }
    case "topic.resolve": {
      const t = s.topics.find(t => t.id === c.payload.topicId);
      if (!t || t.status === "resolved" || t.round === 1 && !(t.status === "escalated" && actor.kind === "user") || t.status === "escalated" && actor.kind !== "user") throw new Error("Independent opinions required; only trusted user may resolve an escalated discussion");
      const from = sender(s, actor, t.runId);
      assertTopicActor(s, from, t.id);
      if (from !== "user" && !t.participants.includes(from)) throw new Error("Not participant");
      t.status = "resolved"; t.conclusion = c.payload.conclusion; t.actionItems = c.payload.actionItems ?? [];
      for (const id of t.participants) enqueue(s, t.runId, from, id, `Topic ${t.id} conclusion (NOT approval): ${t.conclusion}\nAction items: ${JSON.stringify(t.actionItems)}`, { topicId: t.id, topicStage: "conclusion" });
      break;
    }
    case "correction.propose": {
      const p = c.payload; const run = correctableRun(s, p.runId); sender(s, actor, p.runId);
      if (s.corrections.some(x => x.id === p.correctionId)) throw new Error("Correction ID exists");
      const revision = p.criteriaRevision ?? `correction:${p.correctionId}`;
      if (s.attempts.some(a => a.runId === run.id && a.criteriaRevision === revision) || s.corrections.some(c => c.runId === run.id && c.criteriaRevision === revision)) throw new Error("Changed requirements need a new distinct criteria revision");
      if (p.affectedAttemptIds.some(id => { const a = s.attempts.find(a => a.id === id && a.runId === run.id); return !a || current(s, run.id, a.nodeId)?.id !== id; })) throw new Error("Correction must target current attempts in this run");
      if (!p.affectedAttemptIds.some(id => versionFor(s, run).graph.nodes.find(n => n.id === s.attempts.find(a => a.id === id)!.nodeId)?.kind !== "end")) throw new Error("Select work or its check/Gate; terminal-only requirements cannot be executed");
      s.corrections.push({ id: p.correctionId, runId: p.runId, reason: p.reason, requirements: p.requirements ?? p.reason, criteriaRevision: p.criteriaRevision ?? `correction:${p.correctionId}`, affectedAttemptIds: p.affectedAttemptIds, status: "proposed" });
      break;
    }
    case "correction.apply": {
      if (actor.kind !== "user") throw new Error("Only trusted user may apply requirements correction");
      const c1 = s.corrections.find(x => x.id === c.payload.correctionId);
      if (!c1 || c1.status !== "proposed") throw new Error("Correction not proposed");
      const run = correctableRun(s, c1.runId), v = versionFor(s, run);
      preserveLegacyEscalation(s, run);
      if (s.corrections.some(x => x.runId === run.id && x.status === "waiting_boundary") || s.patches.some(x => x.runId === run.id && ["waiting_boundary", "review_required"].includes(x.status))) throw new Error("Another correction/patch awaits a safe boundary or explicit user re-review");
      const nodes = new Set(c1.affectedAttemptIds.map(id => {
        const a = s.attempts.find(a => a.id === id)!;
        if (current(s, run.id, a.nodeId)?.id !== id) throw new Error("Correction proposal is stale; propose against current attempts");
        return a.nodeId;
      }));
      let changed = true;
      while (changed) {
        changed = false;
        // A check/Gate's criteria are bound to its source artifact. Requiring a
        // new check criterion while retaining an old source would deadlock the
        // binding or reuse stale evidence; invalidate that actual source too.
        for (const n of v.graph.nodes) if (nodes.has(n.id) && n.sourceNodeId && !nodes.has(n.sourceNodeId)) { nodes.add(n.sourceNodeId); changed = true; }
        for (const e of v.graph.edges.filter(e => e.kind === "normal")) if (nodes.has(e.from) && !nodes.has(e.to)) { nodes.add(e.to); changed = true; }
      }
      c1.affectedNodeIds = [...nodes];
      c1.affectedAttemptIds = s.attempts.filter(a => a.runId === run.id && nodes.has(a.nodeId) && current(s, run.id, a.nodeId)?.id === a.id).map(a => a.id);
      c1.escalationId = resolutionBasis(s, run, c1.affectedAttemptIds);
      for (const a of s.attempts.filter(a => c1.affectedAttemptIds.includes(a.id))) a.status = "superseded";
      for (const d of s.deliveries.filter(d => c1.affectedAttemptIds.includes(d.attemptId))) d.staleBy = c1.id;
      for (const p of s.approvals.filter(p => c1.affectedAttemptIds.includes(p.attemptId) || c1.affectedAttemptIds.includes(p.targetAttemptId))) p.valid = false;
      c1.notificationIds = [];
      for (const t of s.tasks.filter(t => c1.affectedAttemptIds.includes(t.attemptId))) {
        if (t.child) {
          t.child.staleBy = c1.id;
          if (t.status === "submitted") continue; // preserve completion, no misleading wake/notification
        }
        if (["cancelled", "superseded"].includes(t.status)) continue; // terminal history isn't a new recipient
        t.status = "superseded";
        if (t.sessionId) {
          // There is no superseded-workflow execution authority to consume/ack
          // this notification safely. Escalate explicitly instead of enqueueing
          // a normal continuation that eligibility would silently cancel.
          const messageId = enqueue(s, run.id, "user-correction", t.memberId,
            `Correction ${c1.id}: ${c1.requirements ?? c1.reason}. Old evidence superseded. Stop writes and finish; scheduler waits for native safe boundary.`,
            { correctionId: c1.id, status: "undelivered", continuationAuthorized: false,
              error: `Not sent to original member: superseded workflow has no safe notification/ack execution authority. User action: use dispatch.reconcile inspect/terminate for original task ${t.id}; recover any actual pending message separately by its own ID, not this never-issued notice. Review these new requirements here and follow the replacement attempt. Do not resume old work; replacement brief is NOT proof of predecessor notification.` });
          c1.notificationIds.push(messageId);
          audit(s, "correction.notification_undelivered", actor, `${c1.id}: ${messageId} recipient=${t.memberId}; user action required`);
        }
      }
      if (run.status === "completed") run.status = "running";
      c1.status = "waiting_boundary"; break;
    }
    default: return false;
  }
  return true;
}

/** No lease is released here. Scheduler must first observe native idle + empty inbox/tools/shells. */
export function settleCorrections(s: TeamflowSnapshot, store: TeamflowStore) {
  for (const c of s.corrections.filter(c => c.status === "waiting_boundary")) {
    if (s.tasks.some(t => c.affectedAttemptIds.includes(t.attemptId) &&
      (t.slotHeld || recoveryBlocks(t) || unresolvedIO(s, t) || store.pendingRequestForTask(s.scope, t.id)))) continue;
    const run = s.runs.find(r => r.id === c.runId)!;
    if (["cancelled", "failed", "completed"].includes(run.status)) continue;
    c.replacementAttemptIds = [];
    for (const id of c.affectedAttemptIds) {
      const old = s.attempts.find(a => a.id === id)!;
      const attemptId = uid();
      c.replacementAttemptIds.push(attemptId);
      s.attempts.push({ id: attemptId, runId: run.id, nodeId: old.nodeId, round: old.round + 1, status: "pending", reworkCount: automaticReturns(s, old), previousAttemptId: old.id, criteriaRevision: c.criteriaRevision ?? `correction:${c.id}`, requirements: c.requirements ?? c.reason, reason: `User correction ${c.id}: ${c.reason}`, createdAt: now() });
    }
    c.status = "applied";
    resolveEscalation(run, c.escalationId, "correction", c.id);
  }
}

export function settleTopics(s: TeamflowSnapshot) {
  for (const t of s.topics.filter(t => t.status === "open")) {
    const unavailable = t.participants.filter(id => {
      const m = s.members.find(m => m.id === id);
      const task = s.tasks.find(task => task.id === m?.taskId);
      const a = task && s.attempts.find(a => a.id === task.attemptId);
      return !task || !a || ["superseded", "cancelled", "uncertain"].includes(task.status) || !!task.child?.staleBy ||
        !!a.supersededBy || ["failed", "cancelled", "superseded", "needs_revision"].includes(a.status) ||
        ["cancelled", "failed"].includes(s.runs.find(r => r.id === t.runId)!.status);
    });
    if (unavailable.length) {
      t.status = "escalated";
      t.escalationReason = `Participants no longer actively leased: ${unavailable.join(", ")}. Preserve independent opinions; user must decide. No historical member auto-wake.`;
    }
  }
}
