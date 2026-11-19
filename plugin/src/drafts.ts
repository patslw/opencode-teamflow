import type { ActorContext, TeamflowCommand, TeamflowSnapshot } from "../../packages/protocol/src/index.js";
import { digestVersion, validateVersion } from "./model.js";
import { now } from "./engine.js";
import type { TeamflowStore } from "./store.js";

export function editDraft(s: TeamflowSnapshot, c: TeamflowCommand, actor: ActorContext, store: TeamflowStore): boolean {
  if (c.type === "draft.save") {
    const incoming = c.payload.draft, old = s.drafts.find(d => d.id === incoming.id);
    if (actor.kind !== "user" && !(actor.kind === "agent" && old?.designer?.state === "ready" && old.designer.sessionId === actor.sessionId)) throw new Error("Only user or this draft's independent designer may edit");
    if (incoming.revision !== (old?.revision ?? 0)) throw new Error(`Draft revision conflict: current ${old?.revision ?? 0}; re-read and compare, do not overwrite`);
    if (old && (old.templateId !== incoming.templateId || old.baseVersionId !== incoming.baseVersionId)) throw new Error("Draft identity/base is immutable; copy to a new draft");
    if (incoming.baseVersionId && !s.versions.some(v => v.id === incoming.baseVersionId && v.templateId === incoming.templateId)) throw new Error("Unknown draft base");
    // Invalid intermediate graphs may be saved; validation is mandatory at publication.
    const saved = { ...incoming, revision: incoming.revision + 1, designer: old?.designer };
    if (old) s.drafts[s.drafts.indexOf(old)] = saved; else s.drafts.push(saved);
    return true;
  }
  if (c.type === "draft.publish") {
    if (actor.kind !== "user") throw new Error("Only user may publish");
    const d = s.drafts.find(d => d.id === c.payload.draftId);
    if (!d) throw new Error("Unknown draft");
    if (d.revision !== c.payload.draftRevision) throw new Error("Draft revision conflict: review the current graph/prompts before publishing");
    if (d.designer?.state !== "ready") throw new Error("Create the independent design session before publication");
    const template = s.templates.find(t => t.id === d.templateId) ?? { id: d.templateId, name: d.name ?? d.templateId, description: d.description };
    const version = validateVersion({
      id: c.payload.versionId, templateId: d.templateId, parentVersionId: d.baseVersionId,
      graph: structuredClone(d.graph), roles: structuredClone(d.roles), releaseNotes: c.payload.releaseNotes,
      digest: digestVersion(d), publishedAt: now(),
    });
    if (s.versions.some(v => v.id === version.id)) throw new Error("Version ID already published; choose a new immutable ID");
    store.addVersion(s.scope.backendId, template, version);
    if (!s.templates.some(t => t.id === template.id)) s.templates.push(template);
    s.versions.push(version);
    return true;
  }
  return false;
}
