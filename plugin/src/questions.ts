import type { ActorContext, TeamflowCommand, Task, TeamflowQuestion, TeamflowSnapshot } from "../../packages/protocol/src/index.js";
import { enqueue } from "./collaboration.js";
import { attemptVersion, audit, now, uid } from "./engine.js";
import { bumpIO, conversationEligible, recoveryBlocks } from "./execution-fence.js";
import { teamConversationId } from "./templates/team-conversation.js";

export function isDiscussion(s: TeamflowSnapshot, attemptId: string) {
  const attempt = s.attempts.find(a => a.id === attemptId)!;
  const version = attemptVersion(s, attempt);
  return version.templateId === teamConversationId && version.graph.entry === attempt.nodeId;
}

const answerObserved = (s: TeamflowSnapshot, q: TeamflowQuestion) => q.status === "answered" &&
  s.messages.some(m => m.id === q.answerMessageId && m.to === q.memberId && m.taskId === q.taskId &&
    m.admission === "observed_context" && m.request?.state === "settled" && ["delivered", "acknowledged"].includes(m.status));

export function blockingQuestion(s: TeamflowSnapshot, t: Task) {
  return s.questions.find(q => q.taskId === t.id && q.status !== "superseded" && !answerObserved(s, q));
}
export function assertQuestionResolved(s: TeamflowSnapshot, task: Task) {
  const q = blockingQuestion(s, task);
  if (q) throw new Error(q.status === "open" ? "Wait for the user's answer to your open question" : "Wait for the answer to reach this exact member session");
}
export function confirmedQuestions(s: TeamflowSnapshot, task: Task) {
  return s.questions.filter(q => q.taskId === task.id && answerObserved(s, q)).map(q => ({ id: q.id, question: q.question, answer: q.answer! }));
}

function currentQuestionTask(s: TeamflowSnapshot, q: TeamflowQuestion, recovering = false) {
  const t = s.tasks.find(t => t.id === q.taskId && t.runId === q.runId && t.attemptId === q.attemptId && t.memberId === q.memberId);
  return t && conversationEligible(s, recovering && t.status === "uncertain" ? { ...t, status: "running" } : t, true) ? t : undefined;
}

export function questionCommand(s: TeamflowSnapshot, c: Extract<TeamflowCommand, { type: "question.ask" | "question.answer" }>, actor: ActorContext) {
  if (c.type === "question.ask") {
    if (actor.kind !== "agent") throw new Error("Only the executing member may ask a business question");
    const m = s.members.find(m => !m.legacy && m.sessionId === actor.sessionId);
    const t = m && s.tasks.find(t => t.id === m.taskId && t.memberId === m.id && t.runId === m.runId && t.sessionId === actor.sessionId);
    if (!t || !t.slotHeld || t.status !== "running" || t.executionMode === "conversation" ||
      !conversationEligible(s, t) || recoveryBlocks(t) || s.runs.find(r => r.id === t.runId)?.status === "completed") {
      throw new Error("Question requires a current executing member; paused, finished or stale execution cannot ask");
    }
    assertQuestionResolved(s, t);
    const q: TeamflowQuestion = { id: uid(), runId: t.runId, memberId: t.memberId, attemptId: t.attemptId, taskId: t.id,
      question: c.payload.question, ...(c.payload.options?.length ? { options: c.payload.options } : {}), status: "open", createdAt: now() };
    s.questions.push(q);
    bumpIO(t); // Invalidate an idle observation made before this turn asked.
    return;
  }
  if (actor.kind !== "user") throw new Error("Only the trusted user may answer member questions");
  const q = s.questions.find(q => q.id === c.payload.questionId);
  const t = q && currentQuestionTask(s, q);
  if (!q || q.status !== "open" || !t || t.status !== "running" || recoveryBlocks(t) || s.runs.find(r => r.id === q.runId)?.status === "completed") {
    throw new Error("Question is unknown, already answered, or no longer addressable");
  }
  q.answer = c.payload.answer; q.status = "answered"; q.answeredAt = now();
  q.answerMessageId = enqueue(s, q.runId, "user", q.memberId,
    `用户回复了你的问题（不是方案批准或验收）：\n问题：${q.question}\n回答：${q.answer}\n如果仍有关键疑问，可重新 question.ask；否则继续当前任务。`,
    { taskId: t.id });
}

/** Preserve historical Q&A but revoke applicability of obsolete execution. */
export function settleQuestions(s: TeamflowSnapshot) {
  for (const q of s.questions.filter(q => q.status !== "superseded")) {
    const t = currentQuestionTask(s, q, true);
    const finished = s.runs.find(r => r.id === q.runId)?.status === "completed";
    // Completed runs preserve delivered Q&A but cannot wait on dormant children.
    if (finished ? !!t && answerObserved(s, q) : !!t) continue;
    q.status = "superseded"; q.supersededAt = now();
    const m = s.messages.find(m => m.id === q.answerMessageId);
    if (m?.status === "intent" && !m.request) {
      m.status = "cancelled"; m.error = "Question attempt superseded before native admission";
    }
    audit(s, "question.superseded", { kind: "system" }, q.id);
  }
}
