// Explicitly import a small template into the selected project; never start a run.
import { resolve } from "node:path";
import { backendRegistry } from "../dist/apps/web-host/src/backends.js";
import { digestVersion, validateVersion } from "../dist/plugin/src/model.js";

const [selected, ...rest] = process.argv.slice(2);
if (!selected || rest.length || !/^[^/\s]+\/[^/\s]+$/.test(selected)) {
  throw new Error("Usage: npm run demo:example -- <provider/model> (choose a working model in OpenCode)");
}
const [providerID, id] = selected.split("/");
const registry = await backendRegistry(resolve(process.env.TEAMFLOW_BACKENDS_FILE ?? ".runtime/backends.json"));
const { scope, client, rpc, options } = await registry.select(new URL("http://127.0.0.1/"));
if (!(await client.model.list(options)).data.some(m => m.enabled && m.providerID === providerID && m.id === id)) {
  throw new Error(`Model ${selected} is not enabled on ${scope.backendId}. No template was imported.`);
}
const template = { id: "first-review", name: "第一次体验：核对发布说明", description: "只读核对 → 由你验收 → 结束。没有开发或文件写入步骤。" };
const base = { mode: "demo", writes: false, criteriaRevision: "1", inputs: [], deliverables: [], criteria: ["摘要与题面中的版本号一致"] };
const version = {
  id: "", templateId: template.id, digest: "", publishedAt: "2026-11-19T00:00:00.000Z", releaseNotes: "Alpha 入门练习",
  roles: [{ id: "reviewer", agent: "build", responsibility: "核对一条发布说明", prompt: "只使用题面作为依据。不读写文件，不运行 shell，不委派。用 Teamflow 工具提交核对结果。",
    permissions: ["read"], skills: [], maxDepth: 0, childRoles: [], model: { providerID, id } }],
  graph: { entry: "review-note", requiredGateIds: ["accept"], nodes: [
    { ...base, id: "review-note", kind: "work", role: "reviewer", name: "核对发布说明", deliverables: ["题面核对摘要"],
      prompt: "题面：发布说明写着「Teamflow 0.1 alpha 支持成员私聊」。请准确摘录版本号，使用 teamflow_command 的 task.submit 交付；artifacts 用 brief:release-note，artifactRevision 用 note-v1。不需要读文件或执行命令，不代用户验收。" },
    { ...base, id: "accept", kind: "gate", name: "由你验收", prompt: "检查摘录的版本号，然后批准或说明返工理由。", sourceNodeId: "review-note", gate: { user: true, reviewRoles: [], testRoles: [] } },
    { ...base, id: "done", kind: "end", name: "结束", prompt: "保留交付和验收记录。" },
  ], edges: [{ from: "review-note", to: "accept", kind: "normal" }, { from: "accept", to: "done", kind: "normal" }, { from: "accept", to: "review-note", kind: "return" }] },
};
version.digest = digestVersion(version);
version.id = `${template.id}@${version.digest.slice(0, 12)}`;
validateVersion(version);
const snapshot = await rpc.snapshot(scope, options);
const existing = snapshot.versions.find(v => v.id === version.id);
if (existing && existing.digest !== version.digest) throw new Error("Version ID collision; no changes made");
if (!existing) await rpc.mutate({ scope, requestId: crypto.randomUUID(), expectedRevision: snapshot.revision, command: { type: "template.import", payload: { template, version } } }, options);
console.log(`${existing ? "已有" : "已导入"}「${template.name}」 ${version.id}\n项目：${scope.projectDirectory}\n未启动流程或调用模型。`);
