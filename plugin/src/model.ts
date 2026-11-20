import { createHash } from "node:crypto";
import { VersionSchema, type WorkflowVersion } from "../../packages/protocol/src/index.js";
import { bugFix } from "./templates/bug-fix.js";
import { requireDevelopment } from "./templates/require-development.js";
import { proposalGateId, teamConversation, teamConversationId } from "./templates/team-conversation.js";
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value !== null && typeof value === "object" ? Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)])) : value;
export const digestVersion = (v: Pick<WorkflowVersion, "templateId" | "graph" | "roles">) => createHash("sha256").update(JSON.stringify(canonical({ templateId: v.templateId, graph: v.graph, roles: v.roles }))).digest("hex");
export function validateVersion(input: WorkflowVersion) {
  const v = VersionSchema.parse(input);
  if (v.digest !== digestVersion(v)) throw new Error(`Version digest mismatch for ${v.id}: supplied=${v.digest}, computed=${digestVersion(v)}`);
  const { nodes, edges, entry, requiredGateIds } = v.graph;
  const ids = new Set(nodes.map(n => n.id)), roles = new Set(v.roles.map(r => r.id));
  if (ids.size !== nodes.length || roles.size !== v.roles.length || !ids.has(entry)) throw new Error("Duplicate/invalid node or role");
  for (const e of edges) if (!ids.has(e.from) || !ids.has(e.to) || e.from === e.to) throw new Error("Invalid edge reference");
  if (new Set(edges.map(e => `${e.kind}:${e.from}:${e.to}`)).size !== edges.length) throw new Error("Duplicate edge");
  const normal = edges.filter(e => e.kind === "normal");
  const reach = (from: string, blocked?: string): Set<string> => {
    const seen = new Set<string>();
    const visit = (id: string) => { if (id === blocked || seen.has(id)) return; seen.add(id); normal.filter(e => e.from === id).forEach(e => visit(e.to)); };
    visit(from); return seen;
  };
  const visiting = new Set<string>(), visited = new Set<string>();
  const dfs = (id: string) => {
    if (visiting.has(id)) throw new Error("Normal edges must be acyclic");
    if (visited.has(id)) return;
    visiting.add(id); normal.filter(e => e.from === id).forEach(e => dfs(e.to)); visiting.delete(id); visited.add(id);
  };
  dfs(entry);
  if (visited.size !== nodes.length || normal.some(e => e.to === entry)) throw new Error("Unreachable node or entry has predecessors");
  const ends = nodes.filter(n => n.kind === "end");
  if (!ends.length) throw new Error("Missing terminal");
  for (const n of nodes) {
    if (!ends.some(end => reach(n.id).has(end.id))) throw new Error("Node cannot reach terminal");
    if (n.kind !== "end" && !normal.some(e => e.from === n.id)) throw new Error("Nonterminal dead end");
    if (n.kind === "end" && normal.some(e => e.from === n.id)) throw new Error("Terminal has outgoing edges");
    if (["work", "review", "test"].includes(n.kind) && (!n.role || !roles.has(n.role))) throw new Error("Missing node role");
    if (n.role && !roles.has(n.role)) throw new Error("Unknown role");
    if (n.writes && (!n.role || !v.roles.find(r => r.id === n.role)?.permissions.includes("write"))) throw new Error("Writing node requires a role with write permission");
    if (n.sourceNodeId && (!ids.has(n.sourceNodeId) || !reach(n.sourceNodeId).has(n.id) || nodes.find(x => x.id === n.sourceNodeId)?.kind !== "work")) throw new Error("Invalid artifact source");
    if (n.sourceNodeId && nodes.find(x => x.id === n.sourceNodeId)?.criteriaRevision !== n.criteriaRevision) throw new Error(`Unsupported independent criteriaRevision: ${n.id} (${n.criteriaRevision}) and artifact source ${n.sourceNodeId} (${nodes.find(x => x.id === n.sourceNodeId)?.criteriaRevision}) must share criteriaRevision; update the source and all bound checks/Gates together before publication`);
    if (["review", "test", "gate"].includes(n.kind) && !n.sourceNodeId) throw new Error("Missing artifact source");
    if (n.kind === "gate") {
      if (!n.gate || !requiredGateIds.includes(n.id)) throw new Error("Gate must be declared mandatory");
      for (const [kind, required] of [["review", n.gate.reviewRoles], ["test", n.gate.testRoles]] as const) {
        // All normal predecessors are required (AND join), not alternative routes.
        for (const role of required) if (!roles.has(role) || !nodes.some(check => check.kind === kind && check.role === role && check.sourceNodeId === n.sourceNodeId && reach(check.id).has(n.id))) throw new Error("Required check can be bypassed or missing");
      }
    } else if (n.gate) throw new Error("Only gate nodes declare approvals");
  }
  for (const gate of requiredGateIds) if (nodes.find(n => n.id === gate)?.kind !== "gate" || ends.some(end => reach(entry, gate).has(end.id))) throw new Error("Mandatory gate can be bypassed");
  for (const e of edges.filter(e => e.kind === "return")) {
    if (edges.filter(other => other.kind === "return" && other.from === e.from).length > 1) throw new Error(`Ambiguous return edges from ${e.from}: Demo supports exactly one return target per node (normal branches are AND)`);
    if (!["gate", "review", "test"].includes(nodes.find(n => n.id === e.from)!.kind) || nodes.find(n => n.id === e.to)!.kind !== "work" || !reach(e.to).has(e.from)) throw new Error("Invalid return target");
  }
  for (const r of v.roles) if (r.childRoles.some(id => !roles.has(id))) throw new Error("Unknown child role");
  if (v.templateId === teamConversationId) {
    const discussion = nodes.find(n => n.id === entry)!;
    const confirmation = nodes.find(n => n.id === proposalGateId);
    if (discussion.kind !== "work" || discussion.writes || discussion.mode !== "analysis" ||
      v.roles.find(r => r.id === discussion.role)?.childRoles.length || !confirmation?.gate?.user ||
      confirmation.sourceNodeId !== entry || normal.filter(e => e.from === entry).length !== 1 ||
      !normal.some(e => e.from === entry && e.to === proposalGateId) ||
      normal.filter(e => e.to === proposalGateId).length !== 1) {
      throw new Error("Conversation template must start with read-only discussion followed by explicit user confirmation before other nodes");
    }
  }
  return v;
}
export const builtins = [bugFix, requireDevelopment, teamConversation].map(({ template, graph, roles }) => {
  const content = { templateId: template.id, graph, roles };
  const version = validateVersion({ ...content, id: `${template.id}@1`, releaseNotes: "Built-in demo v1", digest: digestVersion(content), publishedAt: "2026-11-16T00:00:00.000Z" });
  return { template, version };
});
