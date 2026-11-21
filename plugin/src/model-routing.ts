import type { Plugin } from "@opencode/plugin";
import type { ActorContext, ModelCandidate, ModelCatalogEntry, ModelPlan, ModelRef, ModelTarget, Run, StageAttempt, TeamflowCommand, TeamflowSnapshot } from "../../packages/protocol/src/index.js";
import { attemptVersion, current, versionFor } from "./engine.js";
import { conversationEligible, recoveryBlocks } from "./execution-fence.js";
import { blockingQuestion } from "./questions.js";

export const modelKey = ({ providerID, id }: ModelRef) => JSON.stringify([providerID, id]);
export const sameModel = (a: ModelRef, b: ModelRef) => a.providerID === b.providerID && a.id === b.id;

// These are optional Teamflow metadata suggestions, not provider capability claims.
const examples: Record<string, Pick<ModelCandidate, "tags" | "purpose">> = {
  "gpt-6.2-astra": { tags: ["复杂任务", "架构"], purpose: "有较多不确定性、跨组件取舍或较高风险的架构任务" },
  "gpt-6.2-sol": { tags: ["编码", "调试"], purpose: "实现、重构和需要实际调试的任务" },
  "gpt-6.1-terra": { tags: ["轻量", "核对"], purpose: "边界清晰的核对、整理和轻量分析" },
};
export async function enabledModels(ctx: Plugin.Context): Promise<ModelCatalogEntry[]> {
  try {
    const models = new Map<string, ModelCatalogEntry>();
    for (const row of (await ctx.model.list()).data) {
      if (!row.enabled) continue;
      const model = { providerID: row.providerID, id: row.id };
      const example = row.providerID === "openai" && Object.hasOwn(examples, row.id) ? examples[row.id] : undefined;
      models.set(modelKey(model), { model, name: row.name || row.id, ...(example ? { example } : {}) });
    }
    return [...models.values()].sort((a, b) => a.name.localeCompare(b.name) || modelKey(a.model).localeCompare(modelKey(b.model)));
  } catch { throw new Error("Could not read enabled models from this OpenCode backend"); }
}

type ModelCommand = Extract<TeamflowCommand, { type: "model.plan" | "model.candidates" | "model.clear" }>;
const sameTarget = (a: ModelTarget, b: ModelTarget) => a.kind === b.kind && a.id === b.id;
const editableAttempt = (s: TeamflowSnapshot, a: StageAttempt) =>
  !a.supersededBy && ["pending", "ready"].includes(a.status) && !s.tasks.some(t => t.attemptId === a.id && !t.child);

export function mayPlanModels(s: TeamflowSnapshot, run: Run, sessionId: string) {
  if (!["running", "waiting"].includes(run.status)) return false;
  const m = s.members.find(m => m.sessionId === sessionId && m.runId === run.id && m.role === "coordinator" && !m.legacy);
  const t = m && s.tasks.find(t => t.id === m.taskId && t.memberId === m.id && t.sessionId === sessionId && t.runId === run.id);
  const a = t && s.attempts.find(a => a.id === t.attemptId);
  return !!(t && a && !t.child && !t.writes && t.slotHeld && t.dispatch?.delivery === "admitted" && !recoveryBlocks(t) &&
    conversationEligible(s, t) && attemptVersion(s, a).graph.nodes.some(n => n.id === a.nodeId && n.role === "coordinator"));
}

export function routingRun(s: TeamflowSnapshot, c: ModelCommand, actor: ActorContext): Run {
  const run = s.runs.find(r => r.id === c.payload.runId);
  if (!run || !["running", "waiting", "paused"].includes(run.status)) throw new Error("Model routing requires a live Teamflow run");
  if (actor.kind === "user") return run;
  if (c.type !== "model.plan" || actor.kind !== "agent" || !mayPlanModels(s, run, actor.sessionId)) {
    throw new Error("Only the trusted user or this run's current read-only coordinator can plan models; candidate changes require the user");
  }
  return run;
}

export function applyModelRouting(s: TeamflowSnapshot, c: ModelCommand, actor: ActorContext, enabled: ModelRef[]) {
  const run = routingRun(s, c, actor);
  if (actor.kind === "agent" && s.tasks.some(t => t.sessionId === actor.sessionId && blockingQuestion(s, t))) {
    throw new Error("Wait for your Teamflow question to be answered in this exact session");
  }
  const routing = run.modelRouting ??= { candidates: [], plans: [] };
  if (c.type === "model.candidates") {
    const candidates = c.payload.candidates;
    const keys = new Set(candidates.map(c => modelKey(c.model)));
    if (keys.size !== candidates.length) throw new Error("Duplicate model in candidate pool");
    for (const { model } of candidates) {
      if (!routing.candidates.some(c => sameModel(c.model, model)) && !enabled.some(m => sameModel(m, model))) {
        throw new Error(`Only enabled models can be added: ${model.providerID}/${model.id}`);
      }
    }
    routing.candidates = candidates;
    routing.plans = routing.plans.filter(p => keys.has(modelKey(p.model)));
    return;
  }
  const { target } = c.payload;
  if (c.type === "model.clear") {
    routing.plans = routing.plans.filter(p => p.versionId !== c.payload.versionId || !sameTarget(p.target, target));
    return;
  }
  const { choice } = c.payload;
  const version = versionFor(s, run);
  const a = target.kind === "attempt" ? s.attempts.find(a => a.id === target.id && a.runId === run.id) : current(s, run.id, target.id);
  if (target.kind === "attempt" && (!a || current(s, run.id, a.nodeId)?.id !== a.id || !editableAttempt(s, a))) {
    throw new Error("Model choice requires a current, not yet claimed attempt");
  }
  const executionVersion = target.kind === "attempt" ? attemptVersion(s, a!) : version;
  if (executionVersion.id !== c.payload.versionId) throw new Error("The target workflow version changed; refresh the model plan");
  const node = executionVersion.graph.nodes.find(n => n.id === (target.kind === "stage" ? target.id : a!.nodeId));
  if (!node || !node.role || !["work", "review", "test"].includes(node.kind)) throw new Error("Only executable stages have models");
  if (executionVersion.roles.find(r => r.id === node.role)?.model) throw new Error("This stage has a fixed Teamflow role model; it takes precedence");
  if (actor.kind === "agent" && (!a || !editableAttempt(s, a) || attemptVersion(s, a).id !== executionVersion.id)) {
    throw new Error("Coordinators may only plan not yet claimed stages of the current execution version");
  }
  if (!routing.candidates.some(c => sameModel(c.model, choice.model)) || !enabled.some(m => sameModel(m, choice.model))) {
    throw new Error("Selected model must be in the run's candidate pool and enabled on this backend");
  }
  const match = (p: ModelPlan) => p.versionId === executionVersion.id && sameTarget(p.target, target);
  if (actor.kind === "agent" && routing.plans.some(p => p.source === "user" && (match(p) ||
    p.versionId === executionVersion.id && p.target.kind === "stage" && p.target.id === node.id))) {
    throw new Error("A trusted user's model choice takes precedence");
  }
  routing.plans = routing.plans.filter(p => !match(p));
  routing.plans.push({ ...choice, target, versionId: executionVersion.id, source: actor.kind === "user" ? "user" : "coordinator" });
}

/** Called only at the durable claim, never for a bound/running session or a child. */
export function plannedModel(run: Run, attempt: StageAttempt, versionId: string) {
  const plans = run.modelRouting?.plans.filter(p => p.versionId === versionId);
  for (const source of ["user", "coordinator"] as const) {
    const selected = plans?.find(p => p.source === source && p.target.kind === "attempt" && p.target.id === attempt.id) ??
      plans?.find(p => p.source === source && p.target.kind === "stage" && p.target.id === attempt.nodeId);
    if (selected) return selected;
  }
}

export function availableRouteTargets(s: TeamflowSnapshot, run: Run) {
  const version = versionFor(s, run);
  return s.attempts.filter(a => a.runId === run.id && editableAttempt(s, a) && current(s, run.id, a.nodeId)?.id === a.id)
    .flatMap(a => {
      const v = attemptVersion(s, a);
      const n = v.graph.nodes.find(n => n.id === a.nodeId);
      if (!n?.role || !["work", "review", "test"].includes(n.kind) || v.roles.find(r => r.id === n.role)?.model) return [];
      return [{ stageId: n.id, attemptId: a.id, versionId: v.id, role: n.role, name: n.name, prompt: n.prompt, requirements: a.requirements,
        stageChoiceAvailable: v.id === version.id }];
    });
}
