import { useEffect, useState } from "react";
import type { BackendScope, ModelCandidate, ModelCatalogEntry, ModelRef, ModelTarget, MutationResult, Run, TeamflowCommand, TeamflowSnapshot } from "../../../packages/protocol/src/index";

type Props = {
  scope: BackendScope;
  snapshot: TeamflowSnapshot;
  run: Run;
  mutate: (command: TeamflowCommand) => Promise<MutationResult | undefined>;
  busy: boolean;
  readOnly?: boolean;
};
const key = (model: ModelRef) => JSON.stringify([model.providerID, model.id]);
const label = (model: ModelRef) => `${model.providerID}/${model.id}`;
const targetKey = (target: ModelTarget) => JSON.stringify([target.kind, target.id]);
const emptyCandidate = { model: "", tags: "", purpose: "" };
const emptyPlan = { target: "", versionId: "", model: "", reason: "" };

export function ModelRouting(props: Props) {
  return <RoutingEditor key={JSON.stringify([props.scope.backendId, props.scope.projectDirectory, props.run.id])} {...props} />;
}

function RoutingEditor({ scope, snapshot, run, mutate, busy, readOnly }: Props) {
  const [catalog, setCatalog] = useState<ModelCatalogEntry[]>();
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [candidateEdit, setCandidate] = useState(emptyCandidate);
  const [planEdit, setPlan] = useState(emptyPlan);
  useEffect(() => {
    const abort = new AbortController();
    setCatalog(undefined);
    setError("");
    void fetch(`/api/models?${new URLSearchParams({ backendId: scope.backendId, projectDirectory: scope.projectDirectory })}`, {
      signal: abort.signal, cache: "no-store",
    }).then(async response => {
      if (!response.ok) throw new Error("无法读取此后端的模型目录");
      const models = await response.json() as ModelCatalogEntry[];
      if (!abort.signal.aborted) setCatalog(models);
    }).catch(() => {
      if (!abort.signal.aborted) setError("无法读取此后端的模型目录。已保存的计划仍可查看。");
    });
    return () => abort.abort();
  }, [scope.backendId, scope.projectDirectory, refresh]);

  const versions = new Map(snapshot.versions.map(v => [v.id, v]));
  const version = versions.get(run.versionId);
  const candidates = run.modelRouting?.candidates ?? [];
  const plans = run.modelRouting?.plans ?? [];
  const terminal = !["running", "waiting", "paused"].includes(run.status);
  const locked = !!readOnly || busy || terminal;
  const attempts = snapshot.attempts.filter(a => a.runId === run.id);
  const tasks = snapshot.tasks.filter(t => t.runId === run.id);
  const latest = new Map<string, (typeof attempts)[number]>();
  for (const a of attempts) if ((latest.get(a.nodeId)?.round ?? 0) < a.round) latest.set(a.nodeId, a);
  const stageName = (nodeId: string, versionId = run.versionId) => versions.get(versionId)?.graph.nodes.find(n => n.id === nodeId)?.name ?? nodeId;
  const describeTarget = (target: ModelTarget, versionId: string) => {
    if (target.kind === "stage") return `${stageName(target.id, versionId)}（阶段）`;
    const a = attempts.find(a => a.id === target.id);
    return a ? `${stageName(a.nodeId, versionId)}（第 ${a.round} 次）` : target.id;
  };
  const targets: { target: ModelTarget; versionId: string }[] = [];
  for (const n of version?.graph.nodes ?? []) {
    if (!n.role || !["work", "review", "test"].includes(n.kind) || version?.roles.find(r => r.id === n.role)?.model) continue;
    targets.push({ target: { kind: "stage", id: n.id }, versionId: run.versionId });
  }
  for (const a of latest.values()) {
    if (a.supersededBy || !["pending", "ready"].includes(a.status) || tasks.some(t => !t.child && t.attemptId === a.id)) continue;
    const v = versions.get(a.versionId ?? run.versionId);
    const n = v?.graph.nodes.find(n => n.id === a.nodeId);
    if (v && n?.role && ["work", "review", "test"].includes(n.kind) && !v.roles.find(r => r.id === n.role)?.model) {
      targets.push({ target: { kind: "attempt", id: a.id }, versionId: v.id });
    }
  }
  const enabled = new Map(catalog?.map(item => [key(item.model), item]));
  const candidateOptions = new Map(catalog?.map(item => [key(item.model), item.model]));
  candidates.forEach(item => candidateOptions.set(key(item.model), item.model));
  const selectedCandidate = candidateOptions.get(candidateEdit.model);
  const selectedTarget = targets.find(t => targetKey(t.target) === planEdit.target && t.versionId === planEdit.versionId);
  const selectedPlanModel = enabled.get(planEdit.model)?.model;
  const missingExamples = (catalog ?? []).filter(x => x.example && !candidates.some(c => key(c.model) === key(x.model)));
  const fixed = (version?.graph.nodes ?? []).flatMap(n => {
    const model = version?.roles.find(r => r.id === n.role)?.model;
    return model && ["work", "review", "test"].includes(n.kind) ? [{ node: n, model }] : [];
  });
  const savePool = (next: ModelCandidate[]) => mutate({ type: "model.candidates", payload: { runId: run.id, candidates: next } });
  const modelLabel = (model: ModelRef) => {
    const name = enabled.get(key(model))?.name;
    return name && name !== model.id ? `${name} · ${label(model)}` : label(model);
  };
  const plannedDispatches = tasks.filter(t => t.dispatch?.modelPlan || t.dispatch?.nativeModel);
  const availability = (model: ModelRef) => catalog && !enabled.has(key(model)) ? "（当前未启用）" : "";

  return <section className="model-routing" aria-label="模型计划">
    <h3>模型计划</h3>
    <p>角色固定模型优先；其次使用用户选择，再使用负责人选择。同一来源下，指定尝试优先于阶段计划。未设置就沿用原有默认。模型选择不改变权限、Gate 或已派工会话。</p>
    {error ? <p role="alert">{error}</p> : !catalog && <p>正在读取已启用的模型…</p>}
    <button type="button" onClick={() => setRefresh(n => n + 1)}>刷新模型目录</button>
    {fixed.length > 0 && <ul aria-label="角色固定模型">{fixed.map(({ node, model }) => <li key={node.id}>{node.name}：{modelLabel(model)}{availability(model)}（角色固定）</li>)}</ul>}

    <details open>
      <summary>允许的候选模型（{candidates.length}）</summary>
      {candidates.length === 0 && <p>没有设置候选。负责人将沿用原有默认。</p>}
      {candidates.length > 0 && <ul>{candidates.map(c => <li key={key(c.model)}>
        {modelLabel(c.model)}{availability(c.model)}{c.tags.length ? ` · ${c.tags.join("、")}` : ""}{c.purpose ? `：${c.purpose}` : ""}
        {!readOnly && !terminal && <button type="button" disabled={busy} onClick={() => {
          if (plans.some(p => key(p.model) === key(c.model)) && !window.confirm("移出候选也会移除引用此模型的计划。已派工会话不变。继续吗？")) return;
          void savePool(candidates.filter(old => key(old.model) !== key(c.model)));
        }}>移出候选</button>}
      </li>)}</ul>}
      {!readOnly && !terminal && <fieldset disabled={locked}>
        <legend>添加或编辑候选</legend>
        <label>模型 <select value={candidateEdit.model} onChange={e => {
          const model = e.target.value;
          const metadata = candidates.find(c => key(c.model) === model) ?? enabled.get(model)?.example;
          setCandidate({ model, tags: metadata?.tags.join("、") ?? "", purpose: metadata?.purpose ?? "" });
        }}>
          <option value="">请选择</option>
          {[...candidateOptions].map(([id, model]) => <option key={id} value={id}>{modelLabel(model)}{availability(model)}</option>)}
        </select></label>
        <label>能力标签 <input value={candidateEdit.tags} placeholder="例如：设计、交互、视觉" onChange={e => setCandidate({ ...candidateEdit, tags: e.target.value })} /></label>
        <label>建议用途 <input value={candidateEdit.purpose} maxLength={500} placeholder="例如：设计系统与视觉规范评审" onChange={e => setCandidate({ ...candidateEdit, purpose: e.target.value })} /></label>
        <button type="button" disabled={!selectedCandidate} onClick={() => {
          if (!selectedCandidate) return;
          const tags = [...new Set(candidateEdit.tags.split(/[,，、;]/).map(t => t.trim()).filter(Boolean))];
          void savePool([...candidates.filter(c => key(c.model) !== candidateEdit.model), { model: selectedCandidate, tags, purpose: candidateEdit.purpose }]);
        }}>保存候选</button>
        {missingExamples.length > 0 && <button type="button" onClick={() => {
          void savePool([...candidates, ...missingExamples.map(m => ({ model: m.model, ...m.example! }))]);
        }}>加入本后端已启用的示例</button>}
      </fieldset>}
    </details>

    <details open>
      <summary>阶段与指定尝试的模型计划（{plans.length}）</summary>
      {plans.length > 0 && <ul>{plans.map(p => <li key={`${p.versionId}:${targetKey(p.target)}`}>
        {describeTarget(p.target, p.versionId)}：{modelLabel(p.model)}{availability(p.model)} · {p.source === "user" ? "用户" : "负责人"} · {p.reason}
        {p.versionId !== run.versionId && <small>（计划绑定版本 {p.versionId}）</small>}
        {!readOnly && !terminal && <button type="button" disabled={busy} onClick={() => {
          void mutate({ type: "model.clear", payload: { runId: run.id, target: p.target, versionId: p.versionId } });
        }}>清除计划</button>}
      </li>)}</ul>}
      {!readOnly && !terminal && <fieldset disabled={locked}>
        <legend>设置用户选择</legend>
        <label>目标 <select value={selectedTarget ? planEdit.target : ""} onChange={e => {
          const target = targets.find(t => targetKey(t.target) === e.target.value);
          const saved = plans.find(p => target && p.versionId === target.versionId && targetKey(p.target) === e.target.value);
          setPlan({ target: e.target.value, versionId: target?.versionId ?? "", model: saved ? key(saved.model) : "", reason: saved?.reason ?? "" });
        }}>
          <option value="">请选择阶段或未派工尝试</option>
          {targets.map(t => <option key={targetKey(t.target)} value={targetKey(t.target)}>{describeTarget(t.target, t.versionId)}</option>)}
        </select></label>
        <label>候选模型 <select value={planEdit.model} onChange={e => setPlan({ ...planEdit, model: e.target.value })}>
          <option value="">请选择可用候选</option>
          {candidates.map(c => <option key={key(c.model)} value={key(c.model)} disabled={!enabled.has(key(c.model))}>{modelLabel(c.model)}{availability(c.model)}</option>)}
        </select></label>
        <label>选择理由 <input value={planEdit.reason} maxLength={1000} onChange={e => setPlan({ ...planEdit, reason: e.target.value })} placeholder="结合本次任务的难度和专长" /></label>
        <button type="button" disabled={!selectedTarget || !selectedPlanModel || !planEdit.reason.trim()} onClick={() => {
          if (!selectedTarget || !selectedPlanModel) return;
          void mutate({ type: "model.plan", payload: { runId: run.id, target: selectedTarget.target, versionId: selectedTarget.versionId, choice: { model: selectedPlanModel, reason: planEdit.reason } } });
        }}>保存模型计划</button>
      </fieldset>}
    </details>

    {plannedDispatches.length > 0 && <details>
      <summary>派工记录中的模型（{plannedDispatches.length}）</summary>
      <ul>{plannedDispatches.map(t => {
        const a = attempts.find(a => a.id === t.attemptId);
        const d = t.dispatch!;
        return <li key={t.id}>
          {a ? `${stageName(a.nodeId, a.versionId)} · 第 ${a.round} 次` : t.id}
          {t.child ? " · 辅助成员" : ""}：
          {d.nativeModel ? ` 原生会话已确认 ${modelLabel(d.nativeModel)}` : " 尚无原生模型确认"}
          {d.modelPlan ? ` · 派工选择 ${label(d.modelPlan.model)}（${d.modelPlan.source === "user" ? "用户" : "负责人"}：${d.modelPlan.reason}）` : ""}
          {t.error && <small> · {t.error}</small>}
        </li>;
      })}</ul>
    </details>}
  </section>;
}
