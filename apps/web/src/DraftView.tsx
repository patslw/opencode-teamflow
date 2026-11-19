import React, { useEffect, useRef, useState } from "react";
import { DraftSchema, type MutationResult, type TeamflowCommand, type TeamflowSnapshot, type WorkflowVersion } from "../../../packages/protocol/src/index";
import type { TeamflowConnection } from "./connection";

const pretty = (v: unknown) => JSON.stringify(v, null, 2);
export function DraftView({ active, snapshot: s, version, localVersion, preview, mutate, pending, connection, touched, input, setInput, editorEpoch }: {
  active: boolean;
  snapshot: TeamflowSnapshot; version?: WorkflowVersion; localVersion?: WorkflowVersion;
  preview(v: WorkflowVersion): void; pending: boolean; connection?: TeamflowConnection;
  touched(): void;
  input: string; setInput(value: string): void; editorEpoch: React.RefObject<number>;
  mutate(c: TeamflowCommand): Promise<MutationResult | undefined>;
}) {
  const text = input, textRef = useRef(input);
  textRef.current = input;
  const edit = (value: string) => { touched(); textRef.current = value; setInput(value); };
  useEffect(() => {
    if (!text) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [text]);
  const [error, setError] = useState(""), [notes, setNotes] = useState(""), [versionId, setVersionId] = useState("");
   const [brief, setBrief] = useState(""), [messages, setMessages] = useState<unknown>();
  useEffect(() => { if (!active) setMessages(undefined); }, [active]);
  const agent = "teamflow-process-designer";
  const epoch = editorEpoch;
  const replace = (value: unknown) => {
    if (text && !confirm("替换本面板输入？请先保存/复制未保存的内容。")) return;
    epoch.current++; edit(pretty(value)); setMessages(undefined);
  };
  let parsed: ReturnType<typeof DraftSchema.parse> | undefined;
  try { if (text) parsed = DraftSchema.parse(JSON.parse(text)); } catch { /* editable invalid input */ }
  const saved = s.drafts.find(d => d.id === parsed?.id);
  const content = (d: ReturnType<typeof DraftSchema.parse>) => ({ id: d.id, templateId: d.templateId, name: d.name, baseVersionId: d.baseVersionId, graph: d.graph, roles: d.roles, description: d.description });
  const same = !!parsed && !!saved && parsed.revision === saved.revision &&
    pretty(content(parsed)) === pretty(content(saved));
  const perform = async (fn: () => Promise<unknown>) => { setError(""); try { await fn(); } catch (e) { setError(String(e)); } };
  return <section aria-label="持久化草稿与独立设计">
    <h2>共享草稿 / 独立设计会话</h2>
    <p>图编辑器仍是本地输入；先“采用图编辑器内容”再保存。并发冲突不会覆盖输入，展开保存内容比较后显式重读。发布不升级任何实例。</p>
    <button disabled={!version || pending} onClick={() => version && replace({
      id: `draft-${crypto.randomUUID()}`, templateId: version.templateId, baseVersionId: version.id,
      revision: 0, graph: version.graph, roles: version.roles, description: "复制发布版本为草稿",
    })}>复制当前版本为新草稿</button>
    <button disabled={!version || pending} onClick={() => version && replace({
      id: `draft-${crypto.randomUUID()}`, templateId: `template-${crypto.randomUUID()}`, name: "新流程",
      revision: 0, graph: version.graph, roles: version.roles, description: "新模板（以当前图为起点，可编辑全部节点/角色）",
    })}>创建新模板草稿（无需 run）</button>
    <label className="field">已持久化草稿<select value="" onChange={e => { const d = s.drafts.find(d => d.id === e.target.value); if (d) replace(d); }}>
      <option value="">选择 / 重读（显式替换输入）</option>{s.drafts.map(d => <option key={d.id} value={d.id}>{d.id} · rev {d.revision}</option>)}
    </select></label>
    <label className="field">草稿完整 JSON（含 graph / roles / 提示词 / Skill 引用）<textarea value={text} onChange={e => { epoch.current++; edit(e.target.value); }} /></label>
    <button disabled={!parsed || !version} onClick={() => parsed && preview({
      id: parsed.id, templateId: parsed.templateId, parentVersionId: parsed.baseVersionId, graph: parsed.graph, roles: parsed.roles,
      releaseNotes: "", digest: "draft-not-published", publishedAt: "draft",
    })}>在图编辑器检查 / 修改</button>
    <button disabled={!parsed || !localVersion || localVersion.templateId !== parsed.templateId} onClick={() => {
      if (parsed && localVersion) { epoch.current++; edit(pretty({ ...parsed, graph: localVersion.graph, roles: localVersion.roles })); }
    }}>采用图编辑器内容（未保存）</button>
    <button disabled={pending || !parsed} onClick={() => void perform(async () => {
      if (!parsed) return;
      const original = textRef.current, identity = epoch.current;
      const result = await mutate({ type: "draft.save", payload: { draft: parsed } });
      if (result && !result.inProgress && identity === epoch.current && original === textRef.current) edit(pretty(result.snapshot.drafts.find(d => d.id === parsed!.id)));
    })}>按当前草稿 revision 保存</button>
    {saved && <details><summary>后端当前草稿 rev {saved.revision} / 与本地比较</summary><pre>{pretty(saved)}</pre></details>}
    {saved && <>
      <p>设计角色：{agent}（请先在项目 .opencode/agents 安装随附只读角色；缺失会明确失败，不降级 build）。</p>
      <label className="field">设计问题 / 用户讨论<textarea value={brief} onChange={e => setBrief(e.target.value)} /></label>
      {!saved.designer && <button disabled={pending || !brief.trim() || !agent} onClick={() => void mutate({ type: "draft.design", payload: { draftId: saved.id, brief, agent } })}>创建独立设计 session（不启动模型）</button>}
      {saved.designer && <article>
        <p>真实设计 session：<code>{saved.designer.sessionId}</code> · {saved.designer.state} · {saved.designer.error}</p>
        <p>TUI：在仓库运行 <code>npm run demo:tui -- {s.scope.backendId} {JSON.stringify(s.scope.projectDirectory)}</code>，Ctrl+P → Teamflow 流程 → 打开独立流程设计会话 → 选择此 ID；下方可读取同一 session。不要用 --session 猜测创建缺失历史。</p>
        <button disabled={pending || saved.designer.state !== "ready" || !brief.trim() || saved.designer.deliveries.some(m => m.state !== "admitted")} onClick={() => void mutate({ type: "draft.discuss", payload: { draftId: saved.id, text: brief } })}>向该设计 session 讨论（真实模型 / 不批准）</button>
        <button onClick={() => void perform(async () => {
          const id = saved.designer!.sessionId, identity = epoch.current;
          const result = await connection?.sessionMessages(id);
          if (identity === epoch.current) setMessages(result);
        })}>读取该 session 原生消息</button>
        <pre>{pretty(saved.designer.deliveries)}</pre>
        {messages !== undefined && <pre>{pretty(messages)}</pre>}
        <p>原生 NotFound/未知 admission 不会重建或重发，必须保留映射与失败边界。</p>
      </article>}
      <label className="field">不可变版本 ID<input value={versionId} onChange={e => setVersionId(e.target.value)} /></label>
      <label className="field">发布说明<textarea value={notes} onChange={e => setNotes(e.target.value)} /></label>
      <button disabled={pending || !same || !versionId || saved.designer?.state !== "ready"} onClick={() => {
        if (confirm(`已经检查保存的 graph / roles / 提示词 rev ${saved.revision}？发布 ${versionId}，不应用到任何 run。`)) void mutate({
          type: "draft.publish", payload: { draftId: saved.id, draftRevision: saved.revision, versionId, releaseNotes: notes },
        });
      }}>用户显式发布所检查的草稿 revision</button>
    </>}
    {error && <p role="alert" className="error">{error}（输入保留）</p>}
  </section>;
}
