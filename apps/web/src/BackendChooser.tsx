import React, { useEffect, useState } from "react";
import type { BackendScope } from "../../../packages/protocol/src/index";

type Catalog = { defaultScope: BackendScope; backends: { backendId: string; projects: string[] }[] };
const key = (s: BackendScope) => JSON.stringify(s);

// Keep each visited workspace's unsaved inputs in memory, but only the active
// workspace owns a connection. No state or async continuation is re-labelled.
export function BackendChooser({ workspace }: {
  workspace(scope: BackendScope, active: boolean): React.ReactNode;
}) {
  const [catalog, setCatalog] = useState<Catalog>();
  const [selected, setSelected] = useState<BackendScope>();
  const [visited, setVisited] = useState<BackendScope[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    const abort = new AbortController();
    void fetch("/api/backends", { signal: abort.signal }).then(async r => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const c: Catalog = await r.json();
      setCatalog(c); setSelected(c.defaultScope); setVisited([c.defaultScope]);
    }).catch(e => { if (!abort.signal.aborted) setError(String(e)); });
    return () => abort.abort();
  }, []);
  function choose(scope: BackendScope) {
    if (!visited.some(s => key(s) === key(scope))) setVisited(v => [...v, scope]);
    setSelected(scope);
  }
  return <>
    <section className="panel" aria-label="后端与项目选择">
      <label>后端 <select aria-label="后端" value={selected?.backendId ?? ""} onChange={e => {
        const b = catalog?.backends.find(b => b.backendId === e.target.value);
        if (b) choose({ backendId: b.backendId, projectDirectory: b.projects[0]! });
      }}>{catalog?.backends.map(b => <option key={b.backendId}>{b.backendId}</option>)}</select></label>
      <label>项目 <select aria-label="项目" value={selected?.projectDirectory ?? ""} onChange={e => selected && choose({ ...selected, projectDirectory: e.target.value })}>
        {catalog?.backends.find(b => b.backendId === selected?.backendId)?.projects.map(p => <option key={p}>{p}</option>)}
      </select></label>
      <span> 仅管理员已配置的端点；切换保留各项目本页输入与未决身份，不自动重试。刷新页面前请保存/复制输入。</span>
      {error && <p role="alert">{error}</p>}
    </section>
    {visited.map(scope => <div key={key(scope)} hidden={key(scope) !== (selected && key(selected))}>
      {workspace(scope, key(scope) === (selected && key(selected)))}
    </div>)}
  </>;
}
