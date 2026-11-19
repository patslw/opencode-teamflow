import type { WorkflowVersion } from "./model.js";

const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** Advisory in clients, recomputed authoritatively in the service. Include role
 * capability dependencies and graph dependency closure in both versions. */
export function patchImpact(base: WorkflowVersion, next: WorkflowVersion, alreadyBlockedNodeIds: string[] = []): string[] {
  const roles = new Set<string>();
  for (const r of [...base.roles, ...next.roles]) if (!equal(base.roles.find(x => x.id === r.id), next.roles.find(x => x.id === r.id))) roles.add(r.id);
  let changed = true;
  while (changed) {
    changed = false;
    for (const r of [...base.roles, ...next.roles]) if (!roles.has(r.id) && r.childRoles.some(id => roles.has(id))) { roles.add(r.id); changed = true; }
  }
  // Recovery must not drop work already invalidated by the previous approval.
  const affected = new Set<string>(alreadyBlockedNodeIds);
  for (const n of [...base.graph.nodes, ...next.graph.nodes]) {
    const before = base.graph.nodes.find(x => x.id === n.id), after = next.graph.nodes.find(x => x.id === n.id);
    if (!equal(before, after) || before?.role && roles.has(before.role) || after?.role && roles.has(after.role)) affected.add(n.id);
  }
  for (const edge of [...base.graph.edges, ...next.graph.edges]) {
    if (!base.graph.edges.some(x => equal(x, edge)) || !next.graph.edges.some(x => equal(x, edge))) { affected.add(edge.from); affected.add(edge.to); }
  }
  if (base.graph.entry !== next.graph.entry || !equal(base.graph.requiredGateIds, next.graph.requiredGateIds)) {
    base.graph.nodes.forEach(n => affected.add(n.id)); next.graph.nodes.forEach(n => affected.add(n.id));
  }
  changed = true;
  while (changed) {
    changed = false;
    // A check/Gate cannot revalidate a retained old artifact under a new basis.
    // Include BOTH source links on redirects/removals, then expand descendants.
    for (const n of [...base.graph.nodes, ...next.graph.nodes]) if (affected.has(n.id) && n.sourceNodeId && !affected.has(n.sourceNodeId)) { affected.add(n.sourceNodeId); changed = true; }
    for (const e of [...base.graph.edges, ...next.graph.edges]) if (affected.has(e.from) && !affected.has(e.to)) { affected.add(e.to); changed = true; }
  }
  return [...affected].sort();
}
