import { node, roles } from "./bug-fix.js";
export const requireDevelopment = {
  template: { id: "require-development", name: "Require development", description: "初步方案 → 用户同意 → 产品 demo → 用户确认 demo → 正式开发 → 专业检查 → 用户验收" },
  roles,
  graph: {
    entry: "proposal", requiredGateIds: ["proposal-confirm", "demo-confirm", "accept"],
    nodes: [
      node("proposal", "work", "coordinator"),
      { ...node("proposal-confirm", "gate", undefined, "proposal"), gate: { user: true, reviewRoles: [], testRoles: [] } },
      { ...node("demo", "work", "developer"), mode: "demo" as const, prompt: "实现产品 demo 验证方向，不进入正式开发。真实提交后等待用户确认。" },
      { ...node("demo-confirm", "gate", undefined, "demo"), gate: { user: true, reviewRoles: [], testRoles: [] } },
      { ...node("formal", "work", "developer"), mode: "formal" as const, prompt: "用户已明确确认产品 demo 后，完成正式方案与开发，重视架构、风格、代码设计与品味，提交自测证据。" },
      node("review", "review", "expert", "formal"), node("test", "test", "tester", "formal"),
      { ...node("accept", "gate", undefined, "formal"), gate: { user: true, reviewRoles: ["expert"], testRoles: ["tester"] } }, node("deliver", "end"),
    ],
    edges: [
      ["proposal", "proposal-confirm", "normal"], ["proposal-confirm", "demo", "normal"], ["demo", "demo-confirm", "normal"],
      ["demo-confirm", "formal", "normal"], ["formal", "review", "normal"], ["formal", "test", "normal"],
      ["review", "accept", "normal"], ["test", "accept", "normal"], ["accept", "deliver", "normal"],
      ["proposal-confirm", "proposal", "return"], ["demo-confirm", "demo", "return"],
      ["review", "formal", "return"], ["test", "formal", "return"], ["accept", "formal", "return"],
    ].map(([from, to, kind]) => ({ from, to, kind: kind as "normal" | "return" })),
  },
};
