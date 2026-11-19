import type { TeamflowMessage, TeamflowSnapshot } from "../../packages/protocol/src/index.js";

export type Association = { topicId?: string; unrelatedReason?: string; relayMessageId?: string };
export function assertTopicActor(s: TeamflowSnapshot, memberId: string, topicId: string) {
  const task = s.tasks.find(t => t.memberId === memberId);
  if (task?.status === "running" && task.child?.topicId && task.child.topicId !== topicId) throw new Error("Active child work is bound to its registered topic; cannot relay it into another topic");
}
export function sealedRound(s: TeamflowSnapshot, topicId: string, round: number) {
  const t = s.topics.find(t => t.id === topicId);
  return !!t && t.participants.every(id => t.responses.some(r => r.memberId === id && (r.round ?? 1) === round));
}
/** Trusted cooperation boundary: explicit association is enforced, not semantic
 * detection of arbitrary disguised prose or malicious same-account shell relays. */
export function associationFor(s: TeamflowSnapshot, runId: string, from: string, to: string, p: Association, completion = false): Association {
  const ownTask = s.tasks.find(t => t.memberId === from && t.runId === runId);
  const child = completion || ownTask?.status === "running" ? ownTask?.child : undefined;
  const relay = p.relayMessageId ? s.messages.find(m => m.id === p.relayMessageId && m.runId === runId && (m.to === from || m.from === from) && ["delivered", "acknowledged"].includes(m.status)) : undefined;
  if (p.relayMessageId && !relay) throw new Error("Relay requires an actually admitted incoming message");
  const inherited = child?.topicId ?? relay?.topicId;
  if (inherited && (p.unrelatedReason || p.topicId && p.topicId !== inherited)) throw new Error("Known topic association cannot be removed or changed");
  const topicId = inherited ?? p.topicId;
  const ambiguous = s.topics.some(t => t.runId === runId && t.status !== "resolved" &&
    (t.participants.includes(from) || t.participants.includes(to) || t.id === ownTask?.child?.topicId));
  // An old "no topic yet" child brief isn't a blanket unrelated classification
  // for topics opened later. Require the finishing/sending actor to choose now.
  const unrelatedReason = p.unrelatedReason ?? (topicId || ambiguous ? undefined : child?.unrelatedReason);
  if (topicId && unrelatedReason) throw new Error("Choose topic association OR explicit unrelated classification");
  if (topicId) {
    const t = s.topics.find(t => t.id === topicId && t.runId === runId);
    if (!t || t.status !== "open" && !completion) throw new Error("Topic closed/escalated; no further discussion through messages/relays/child outlets");
    if (!t.participants.includes(to)) throw new Error("Topic content may only be sent to its registered participants");
  } else if (!unrelatedReason && ambiguous) {
    throw new Error("Ambiguous communication: select topicId or explicit unrelatedReason; unrelated work is allowed");
  }
  return { ...(topicId ? { topicId } : {}), ...(unrelatedReason ? { unrelatedReason } : {}), ...(p.relayMessageId ? { relayMessageId: p.relayMessageId } : {}) };
}
export function messageMayDeliver(s: TeamflowSnapshot, m: TeamflowMessage) {
  if (!m.topicId) return true;
  const t = s.topics.find(t => t.id === m.topicId && t.runId === m.runId);
  if (!t) return false;
  if (m.topicStage === "conclusion") return t.status === "resolved";
  // Associated intents are accepted only while open (late child completions are
  // recorded cancelled). Like exchanges, their sealed round may finish delivery
  // after escalation; this does not authorize any new topic communication.
  if (m.topicStage === "exchange" || m.topicStage === "associated") return sealedRound(s, t.id, m.topicRound ?? 1);
  if (m.topicStage === "question") return t.status === "open" && t.round === 1;
  return t.status === "open" && sealedRound(s, t.id, m.topicRound ?? 1);
}
export function visibleMessage(s: TeamflowSnapshot, m: TeamflowMessage, memberId: string) {
  if (!["delivered", "acknowledged"].includes(m.status)) return false;
  if (m.from === memberId) return true; // Your own admitted content isn't peer disclosure.
  return m.to === memberId && ["delivered", "acknowledged"].includes(m.status) &&
    ["accepted", "observed_inbox", "observed_context"].includes(m.admission ?? "") && messageMayDeliver(s, m);
}
