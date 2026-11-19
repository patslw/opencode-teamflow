import type { WorkflowNode, WorkflowRole } from "../../../packages/protocol/src/index.js";
export const roles: WorkflowRole[] = [
  ["coordinator", "澄清需求与复现，不修改业务代码"],
  ["developer", "实现修复，运行自测，报告证据；提交后立即停止改写文件"],
  ["expert", "独立检视代码、架构、风格和设计，不能代用户审批"],
  ["tester", "独立运行适用检查，报告真实命令与退出码，不伪造结果"],
].map(([id, responsibility]) => ({ id, agent: "build", responsibility, prompt: `${responsibility}。只处理给定任务，不创建未登记的子代理。用 teamflow_command 提交结构化结果。`, skills: [], permissions: id === "developer" ? ["read", "write", "execute"] : ["read", "execute"], childRoles: [], maxDepth: 0 }));
export const node = (id: string, kind: WorkflowNode["kind"], role?: string, sourceNodeId?: string): WorkflowNode => ({
  id, name: id, kind, ...(role ? { role } : {}), mode: "analysis",
  prompt: `${id}：按运行说明完成此阶段，交付真实证据。只读角色不得修改项目文件。`,
  inputs: [], deliverables: ["产物引用及证据"], criteria: ["满足运行说明", "无未解决阻塞问题"], criteriaRevision: "1",
  writes: role === "developer", ...(sourceNodeId ? { sourceNodeId } : {}),
});
const fix = { ...node("fix", "work", "developer"), mode: "formal" as const };
export const bugFix = {
  template: { id: "bug-fix", name: "Bug fix", description: "澄清 → 修复与自测 → 并行专家检视/独立测试 → 用户验收 → 交付" },
  roles,
  graph: {
    entry: "clarify", requiredGateIds: ["accept"],
    nodes: [node("clarify", "work", "coordinator"), fix, node("review", "review", "expert", "fix"), node("test", "test", "tester", "fix"),
      { ...node("accept", "gate", undefined, "fix"), gate: { user: true, reviewRoles: ["expert"], testRoles: ["tester"] } }, node("deliver", "end")],
    edges: [
      ["clarify", "fix", "normal"], ["fix", "review", "normal"], ["fix", "test", "normal"],
      ["review", "accept", "normal"], ["test", "accept", "normal"], ["accept", "deliver", "normal"],
      ["review", "fix", "return"], ["test", "fix", "return"], ["accept", "fix", "return"],
    ].map(([from, to, kind]) => ({ from, to, kind: kind as "normal" | "return" })),
  },
};
