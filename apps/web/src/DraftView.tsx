import React, { useEffect, useRef, useState } from "react";
import { DraftSchema, type MutationResult, type TeamflowCommand, type TeamflowSnapshot, type WorkflowVersion } from "../../../packages/protocol/src/index";
import type { TeamflowConnection } from "./connection";
import { DefinitionChanges } from "./PatchRecovery";
import "./flow-design.css";
import { ChatText } from "./ChatText";

const pretty = (v: unknown) => JSON.stringify(v, null, 2);
export function DraftView({ active, snapshot: s, version, localVersion, preview, mutate, pending, connection, touched, input, setInput, editorEpoch }: {
  active: boolean; snapshot: TeamflowSnapshot; version?: WorkflowVersion; localVersion?: WorkflowVersion;
  preview(v: WorkflowVersion): void; pending: boolean; connection?: TeamflowConnection; touched(): void;
  input: string; setInput(value: string): void; editorEpoch: React.RefObject<number>;
  mutate(c: TeamflowCommand): Promise<MutationResult | undefined>;
}) {
  const text = input, textRef = useRef(input), briefRef = useRef("");
  textRef.current = input;
  const edit = (value: string) => { touched(); textRef.current = value; setInput(value); };
  useEffect(() => {
    if (!text) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn);
  }, [text]);
  const [error, setError] = useState(""), [notice, setNotice] = useState(""), [notes, setNotes] = useState("");
  const [brief, setBrief] = useState(""), [messages, setMessages] = useState<{ sessionId: string; items: unknown[] }>(), [busy, setBusy] = useState(false);
  const epoch = editorEpoch;
  useEffect(() => { if (!active) setMessages(undefined); }, [active]);
  const replace = (value: unknown) => {
    if (textRef.current && !confirm("替换当前草稿输入？请先保存或复制未保存的内容。")) return;
    epoch.current++; edit(pretty(value)); setMessages(undefined);
  };
  let parsed: ReturnType<typeof DraftSchema.parse> | undefined;
  try { if (text) parsed = DraftSchema.parse(JSON.parse(text)); } catch { /* 保留不完整的导入内容 */ }
  const saved = s.drafts.find(d => d.id === parsed?.id);
  const sessionId = saved?.designer?.sessionId;
  useEffect(() => {
    if (!active || !connection || !sessionId) return;
    let live = true, reading = false;
    const load = async () => {
      if (reading) return;
      reading = true;
      try {
        const items = await connection.sessionMessages(sessionId);
        if (live) setMessages({ sessionId, items });
      } catch (e) {
        if (live) setError(`无法读取设计者回复：${String(e)}`);
      } finally { reading = false; }
    };
    void load();
    const timer = window.setInterval(load, 4000);
    return () => { live = false; window.clearInterval(timer); };
  }, [active, connection, sessionId]);
  const content = (d: ReturnType<typeof DraftSchema.parse>) => ({ id: d.id, templateId: d.templateId, name: d.name, baseVersionId: d.baseVersionId, graph: d.graph, roles: d.roles, description: d.description });
  const same = !!parsed && !!saved && parsed.revision === saved.revision && pretty(content(parsed)) === pretty(content(saved));
  const perform = async (fn: () => Promise<void>) => { setError(""); setNotice(""); setBusy(true); try { await fn(); } catch (e) { setError(String(e)); } finally { setBusy(false); } };
  const freshDraft = () => version && ({ id: `draft-${crypto.randomUUID()}`, templateId: version.templateId, baseVersionId: version.id, revision: 0, graph: version.graph, roles: version.roles, description: "复制发布版本为草稿" });
  const discuss = () => void perform(async () => {
    const question = briefRef.current.trim(), original = textRef.current;
    if (!question) return;
    let draft = parsed;
    if (!draft) {
      if (original) throw new Error("当前导入的草稿内容无法读取，请先修正或另存后清空。");
      draft = freshDraft();
      if (!draft) throw new Error("请先选择一个流程版本作为讨论起点。");
      edit(pretty(draft));
    }
    const draftText = textRef.current;
    const identity = epoch.current;
    const unchanged = () => identity === epoch.current && draftText === textRef.current && question === briefRef.current.trim();
    let current = s.drafts.find(d => d.id === draft!.id);
    if (!same || !current) {
      const result = await mutate({ type: "draft.save", payload: { draft } });
      if (!result || result.inProgress) { setNotice("草稿保存结果尚未确定；请先检查状态，不会自动重试或发送讨论。"); return; }
      current = result.snapshot.drafts.find(d => d.id === draft!.id);
      if (!current) throw new Error("保存结果中未找到草稿，请检查状态。");
      if (!unchanged()) { setNotice("草稿已保存，但输入发生变化；请检查后再发送讨论。"); return; }
      edit(pretty(current));
    }
    if (!current) return;
    const currentText = textRef.current;
    const savedIdentity = epoch.current;
    const stillUnchanged = () => savedIdentity === epoch.current && currentText === textRef.current && question === briefRef.current.trim();
    if (!current.designer) {
      const result = await mutate({ type: "draft.design", payload: { draftId: current.id, brief: question, agent: "teamflow-process-designer" } });
      if (!result || result.inProgress) { setNotice("设计者连接结果尚未确定；请先检查状态，不会自动重试或发送讨论。"); return; }
      current = result.snapshot.drafts.find(d => d.id === current!.id);
      if (!current?.designer || current.designer.state !== "ready") { setNotice("设计者未能确认就绪，请查看下方状态；不会重新创建。"); return; }
      if (!stillUnchanged()) { setNotice("设计者已连接，但输入发生变化；请检查后再发送讨论。"); return; }
    }
    if (current.designer?.state !== "ready" || current.designer.deliveries.some(m => m.state !== "admitted")) {
      setNotice("设计者或上一条消息的状态尚未确定；请先检查，不会自动重发。"); return;
    }
    const result = await mutate({ type: "draft.discuss", payload: { draftId: current.id, text: question } });
    if (!result || result.inProgress) { setNotice("消息发送结果尚未确定；请先检查状态，不会自动重发。"); return; }
    const designer = result.snapshot.drafts.find(d => d.id === current!.id)?.designer;
    if (designer?.deliveries.at(-1)?.state !== "admitted") { setNotice("消息送达状态未知；请先检查，不会自动重发。"); return; }
    if (briefRef.current.trim() === question) { briefRef.current = ""; setBrief(""); }
    setNotice("已送交独立设计者。回复可能需要一点时间，请刷新讨论记录查看。");
    if (connection && designer.sessionId) {
      try { setMessages({ sessionId: designer.sessionId, items: await connection.sessionMessages(designer.sessionId) }); } catch { /* 发送已成功，读取可单独重试 */ }
    }
  });
  return <section aria-label="持久化草稿与独立设计" className="flow-design">
    <h2>和流程设计者讨论</h2>
    <p>用自己的话说明想改什么。设计者会基于草稿与你讨论；讨论不会发布流程，也不会改变正在运行的工作。</p>
    <div className="flow-design-card">
      <h3>1. 讨论方案</h3>
      <p>{saved ? `当前草稿：${saved.name || "未命名草稿"}` : parsed ? "当前是尚未保存的草稿。" : "将以当前流程版本创建草稿，首次讨论时自动保存并连接独立设计者。"}</p>
      <label className="field">你想怎样改进流程？<textarea value={brief} placeholder="例如：遇到审核不通过时，希望先让负责人补充说明，再重新审核。" onChange={e => { briefRef.current = e.target.value; setBrief(e.target.value); }} /></label>
      <button disabled={pending || busy || !brief.trim() || (!parsed && (!version || !!text))} onClick={discuss}>{busy ? "正在处理…" : "发送给设计者讨论"}</button>
      {saved?.designer && <button disabled={!connection || busy} onClick={() => void perform(async () => { const id = saved.designer!.sessionId; const items = await connection!.sessionMessages(id); setMessages({ sessionId: id, items }); })}>刷新讨论记录</button>}
      {saved?.designer && <p>{saved.designer.state === "ready" && saved.designer.deliveries.every(m => m.state === "admitted") ? "设计者已连接，回复会自动刷新。" : "设计者或消息状态未确认；不会自动重试。"} {saved.designer.error}</p>}
      {saved?.designer && (() => {
        const deliveries = saved.designer.deliveries;
        const items = messages && messages.sessionId === sessionId ? messages.items : [];
        const seen = new Set<string>();
        const conversation = items.flatMap((value, i) => {
          if (!value || typeof value !== "object") return [];
          const m = value as { id?: string; type?: string; info?: { id?: string; role?: string }; role?: string; text?: string; parts?: { type?: string; text?: string; synthetic?: boolean; ignored?: boolean }[]; content?: { type?: string; text?: string; synthetic?: boolean; ignored?: boolean }[] };
          const id = m.id ?? m.info?.id;
          const delivery = deliveries.find(d => d.id === id);
          if (delivery) { seen.add(delivery.id); return [{ key: delivery.id, who: "你", text: delivery.text }]; }
          if ((m.info?.role ?? m.role ?? m.type) !== "assistant") return [];
          const text = (m.parts ?? m.content ?? []).filter(p => p.type === "text" && !p.synthetic && !p.ignored && typeof p.text === "string").map(p => p.text).join("\n") || (typeof m.text === "string" ? m.text : "");
          return text.trim() ? [{ key: id ?? `reply-${i}`, who: "设计者", text }] : [];
        });
        const missing = deliveries.filter(d => !seen.has(d.id)).map(d => ({ key: d.id, who: "你", text: d.text }));
        return <div aria-label="讨论记录">{[...conversation, ...missing].map(item => <article className="flow-design-message" key={item.key}><strong>{item.who}</strong><ChatText text={item.text}/></article>)}</div>;
      })()}
      {notice && <p role="status">{notice}</p>}{error && <p role="alert" className="error">{error}（输入保留）</p>}
    </div>
    <div className="flow-design-card"><h3>2. 检查并保存草稿</h3>
      <p>在图编辑器检查修改。保存只保存草稿，不会发布；设计者也可能修改已保存草稿，重读前请保护本地输入。</p>
      <button disabled={!version || pending || busy} onClick={() => { const d = freshDraft(); if (d) replace(d); }}>从当前版本新建草稿</button>
      <button disabled={!version || pending || busy} onClick={() => version && replace({ id: `draft-${crypto.randomUUID()}`, templateId: `template-${crypto.randomUUID()}`, name: "新流程", revision: 0, graph: version.graph, roles: version.roles, description: "新模板" })}>新建流程草稿</button>
      <label className="field">打开已保存草稿<select value="" onChange={e => { const d = s.drafts.find(d => d.id === e.target.value); if (d) replace(d); }}><option value="">选择草稿（将替换当前输入）</option>{s.drafts.map(d => <option key={d.id} value={d.id}>{d.name || "未命名草稿"} · 第 {d.revision} 次保存</option>)}</select></label>
      {text && !parsed && <p role="alert">当前草稿内容无法读取。请先通过主入口处理原有内容，或确认替换为已保存草稿。</p>}
      {saved && !same && <p role="alert">本地内容与已保存草稿不同。保存前请检查是否有其他人的修改；重读会替换本地输入。</p>}
      {saved && parsed && !same && <details><summary>比较本地草稿与已保存草稿</summary><p>以下比较以本地草稿为原来、已保存草稿为现在。重读前请确认是否要放弃本地修改。</p><DefinitionChanges base={{ id: parsed.id, templateId: parsed.templateId, graph: parsed.graph, roles: parsed.roles, releaseNotes: "", digest: "draft", publishedAt: "draft" }} next={{ id: saved.id, templateId: saved.templateId, graph: saved.graph, roles: saved.roles, releaseNotes: "", digest: "draft", publishedAt: "draft" }} /></details>}
      <button disabled={!parsed || !version} onClick={() => parsed && preview({ id: parsed.id, templateId: parsed.templateId, parentVersionId: parsed.baseVersionId, graph: parsed.graph, roles: parsed.roles, releaseNotes: "", digest: "draft-not-published", publishedAt: "draft" })}>在图编辑器中检查</button>
      <button disabled={!parsed || !localVersion || localVersion.templateId !== parsed.templateId} onClick={() => { if (parsed && localVersion) { epoch.current++; edit(pretty({ ...parsed, graph: localVersion.graph, roles: localVersion.roles })); } }}>采用图编辑器的修改</button>
      <button disabled={pending || busy || !parsed} onClick={() => void perform(async () => { if (!parsed) return; const original = textRef.current, identity = epoch.current; const result = await mutate({ type: "draft.save", payload: { draft: parsed } }); if (result && !result.inProgress && identity === epoch.current && original === textRef.current) { const d = result.snapshot.drafts.find(d => d.id === parsed.id); if (d) edit(pretty(d)); setNotice("草稿已保存，尚未发布。"); } else setNotice("保存结果尚未确认或输入已变化；请检查草稿状态。"); })}>保存草稿</button>
    </div>
    <div className="flow-design-card"><h3>3. 发布流程</h3><p>确认图和角色都已检查并保存后，再发布为新版本。发布不会自动应用到正在运行的工作。</p>
      <label className="field">发布说明（可选）<textarea value={notes} onChange={e => setNotes(e.target.value)} /></label>
      <button disabled={pending || busy || !same || !saved || saved.designer?.state !== "ready"} onClick={() => { if (saved && confirm("确认已检查保存的草稿？发布后不会自动应用到任何正在运行的工作。")) void mutate({ type: "draft.publish", payload: { draftId: saved.id, draftRevision: saved.revision, versionId: `version-${crypto.randomUUID()}`, releaseNotes: notes } }); }}>确认发布新版本</button>
      {(!saved || !same || saved.designer?.state !== "ready") && <p>发布前需要保存当前草稿，并连接好设计者。</p>}
    </div>
  </section>;
}
