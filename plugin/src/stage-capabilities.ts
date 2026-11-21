import type { Plugin } from "@opencode/plugin";
import type { Task, TeamflowSnapshot } from "../../packages/protocol/src/index.js";
import { attemptVersion } from "./engine.js";
import { isDiscussion } from "./questions.js";
import { teamConversationId } from "./templates/team-conversation.js";
import { TEAMFLOW_COMMAND, TEAMFLOW_CONTEXT } from "./tool-contract.js";

// 2.3.x exposes registered plugin/MCP tools through tool.list; the built-in
// catalog also has effective IDs outside that registry (notably execute).
const builtinTools: Record<string, string> = {
  execute: "Code Mode runner",
  read: "Read files and directories", glob: "Find files", grep: "Search file contents",
  edit: "Edit files", write: "Write files", patch: "Apply a text patch",
  shell: "Run a shell command", skill: "Load an installed OpenCode skill",
  question: "Pause the native session for a user form",
  webfetch: "Fetch a URL", websearch: "Search the web",
};
const readTools = new Set(["read", "glob", "grep", "skill"]);
const writeTools = new Set(["edit", "write", "patch"]);
const infrastructure = new Set(["execute", TEAMFLOW_COMMAND, TEAMFLOW_CONTEXT]);
const neverTools = (id: string) => ["subagent", "task", "bash"].includes(id) ||
  id.startsWith("opencode_") && !["opencode_list_mcp_resources", "opencode_read_mcp_resource"].includes(id);

export async function listCapabilities(ctx: Plugin.Context) {
  const [skills, registered] = await Promise.all([ctx.skill.list(), ctx.tool.list()]);
  const tools = new Map(Object.entries(builtinTools));
  for (const tool of registered) tools.set(tool.id, tool.description);
  return {
    skills: skills.data.map(({ id, name, description }) => ({ id, name, description: description ?? "" })).sort((a, b) => a.id.localeCompare(b.id)),
    tools: [...tools].filter(([id]) => !neverTools(id)).map(([id, description]) => ({ id, description })).sort((a, b) => a.id.localeCompare(b.id)),
  };
}

export function stageCapabilities(s: TeamflowSnapshot, sessionId: string) {
  const member = s.members.find(m => m.sessionId === sessionId);
  const task = member && s.tasks.find(t => t.id === member.taskId && t.sessionId === sessionId);
  if (task) return taskCapabilities(s, task);
}

export function taskCapabilities(s: TeamflowSnapshot, task: Task) {
  const attempt = s.attempts.find(a => a.id === task.attemptId);
  if (!attempt) return;
  const version = attemptVersion(s, attempt);
  const node = version.graph.nodes.find(n => n.id === attempt.nodeId);
  const role = version.roles.find(r => r.id === (task.child?.role ?? node?.role));
  if (!node || !role) return;
  const discussion = isDiscussion(s, attempt.id);
  const skills = node.skills ?? role.skills;
  const roleAllows = (id: string) => role.permissions.includes(id);
  const allowsTool = (id: string) => {
    if (infrastructure.has(id)) return true; // Not a grant: the native rules still apply.
    if (neverTools(id)) return false;
    if (node.tools && !node.tools.includes(id) && !(id === "skill" && skills.length)) return false;
    if (id === "question") return roleAllows("question") || roleAllows("read");
    if (readTools.has(id)) return roleAllows(id) || roleAllows("read");
    if (discussion) return false;
    if (writeTools.has(id)) return task.writes && roleAllows("write");
    if (id === "shell") return !task.child && !(version.templateId === teamConversationId && !task.writes) && roleAllows("execute");
    if (["webfetch", "websearch", "opencode_list_mcp_resources", "opencode_read_mcp_resource"].includes(id)) return roleAllows(id) || roleAllows("execute");
    // Unknown extensions may mutate state. Keep them out of read-only phases
    // and always out of discussion, even if the name sounds harmless.
    return task.writes && (roleAllows(id) || roleAllows("execute"));
  };
  return {
    allowsTool, skills,
    allowsAction(action: string, resources: ReadonlyArray<string>) {
      if (action === "external_directory") return true; // Independent host check, never overridden
      if (action === "edit") return [...writeTools].some(allowsTool);
      if (action === "skill" && node.skills !== undefined && !resources.every(id => node.skills!.includes(id))) return false;
      return allowsTool(action);
    },
  };
}

export async function deniedActions(ctx: Plugin.Context, policy: NonNullable<ReturnType<typeof taskCapabilities>>) {
  const registered = await ctx.tool.list();
  const ids = new Map(Object.keys(builtinTools).map(id => [id, writeTools.has(id) ? "edit" : id]));
  for (const tool of registered) ids.set(tool.id, tool.options?.permission ?? ids.get(tool.id) ?? tool.id);
  const allowedActions = new Set([...ids].filter(([id]) => policy.allowsTool(id)).map(([, action]) => action));
  const allowedCoreActions = ["external_directory", "edit", "subagent", "webfetch"].filter(action => policy.allowsAction(action, []));
  return [...new Set([...ids.values(), "subagent", "webfetch"].filter(action => !allowedActions.has(action) && !allowedCoreActions.includes(action) && action !== "*"))];
}
