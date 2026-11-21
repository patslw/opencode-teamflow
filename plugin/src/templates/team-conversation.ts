import type { WorkflowGraph, WorkflowRole } from "../../../packages/protocol/src/index.js";
import { node } from "./bug-fix.js";

export const teamConversationId = "team-conversation";
export const proposalGateId = "proposal-confirm";
export const teamConversation = {
  template: { id: teamConversationId, name: "先讨论，再实现", description: "协调者先与用户澄清需求 → 用户确认方案 → 实现 Demo → 独立审查 → 用户验收。审查或验收未通过则退回修改。" },
  roles: [
    { id: "coordinator", agent: "teamflow-coordinator", responsibility: "只读澄清需求并提交待确认方案", prompt: "先真实向用户询问会影响实现的关键问题。收到回答后，必要时继续问，最后说明已确认事项、实现范围、Demo 验收标准和未决项。不可把回复当成批准。", skills: [], permissions: ["read"], childRoles: [], maxDepth: 0 },
    { id: "developer", agent: "teamflow-developer", responsibility: "按已确认方案实现可用 Demo", prompt: "以经用户批准的协调方案和已确认回答为准，实际实现最小可用 Demo 并做适当的真实自测。遇到影响范围或验收的疑问先询问，不要擅自决定。", skills: [], permissions: ["read", "write", "execute"], childRoles: [], maxDepth: 0 },
    { id: "expert", agent: "teamflow-expert", responsibility: "在独立会话审查真实 Demo", prompt: "检查实际产物和已确认的验收标准。独立判断、指出具体问题；遇到重大分歧可用受控消息与开发交流，用户才能批准验收。", skills: [], permissions: ["read"], childRoles: [], maxDepth: 0 },
  ] satisfies WorkflowRole[],
  graph: {
    entry: "proposal", requiredGateIds: [proposalGateId, "accept"],
    nodes: [
      { ...node("proposal", "work", "coordinator"), name: "需求讨论与方案", prompt: `首次调用 teamflow_command {"type":"question.ask","payload":{"question":"<一个能改变方案的具体问题>"}}，然后结束本轮等待。真实收到用户答复后，仍有关键问题就再问；否则以 task.submit 提交可供用户批准的方案。summary 写明已确认信息、范围与验收方式，artifacts 用方案内容引用，例如「本会话方案」，而不是不存在的文件。不写代码、不运行 shell。` },
      { ...node(proposalGateId, "gate", undefined, "proposal"), name: "确认方案", gate: { user: true, reviewRoles: [], testRoles: [] } },
      { ...node("demo", "work", "developer"), name: "实现 Demo", mode: "demo" as const, prompt: "根据已获批准的方案做出可运行 Demo，实际提交产物路径、打开或运行方式与自测结果。如有退回，逐项处理退回原因。" },
      { ...node("review", "review", "expert", "demo"), name: "独立审查", prompt: "检查 Demo 产物、方案依据和退回修复情况，不得自审、代用户批准或伪造证据。" },
      { ...node("accept", "gate", undefined, "demo"), name: "用户验收", gate: { user: true, reviewRoles: ["expert"], testRoles: [] } },
      { ...node("deliver", "end"), name: "交付" },
    ],
    edges: [
      ["proposal", proposalGateId, "normal"], [proposalGateId, "demo", "normal"], ["demo", "review", "normal"],
      ["review", "accept", "normal"], ["accept", "deliver", "normal"],
      [proposalGateId, "proposal", "return"], ["review", "demo", "return"], ["accept", "demo", "return"],
    ].map(([from, to, kind]) => ({ from, to, kind: kind as "normal" | "return" })),
  },
};

export const teamConversationGraphV2: WorkflowGraph = {
  ...teamConversation.graph,
  nodes: teamConversation.graph.nodes.map(n => n.id === "proposal" ? {
    ...n, skills: ["teamflow-collaboration"], tools: ["read", "glob", "grep", "skill", "question"],
    prompt: "先用 question.ask 澄清一个会改变方案的关键问题，有实际取舍时给出 2–4 个选项，用户也可自填。结束本轮，收到真实回复后仍有不明确的就继续问。通过 task.submit 提交已确认事项、范围和验收方式，artifacts 可引用「本会话方案」。原生 question 仅收集当轮意见，不代替业务澄清或方案批准。不写代码、不运行 shell、不委派。",
  } : n.id === "demo" ? {
    ...n, tools: ["read", "glob", "grep", "skill", "question", "edit", "write", "patch", "shell"],
  } : n.id === "review" ? {
    ...n, tools: ["read", "glob", "grep", "skill", "question"],
  } : n),
};
