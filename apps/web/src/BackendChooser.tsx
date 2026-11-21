import React, { useEffect, useRef, useState } from "react";
import {firstView,Navigation,type View} from "./navigation";
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
  const [views,setViews]=useState<Record<string,View>>({});
  const [depth,setDepth]=useState(0);
  const all=useRef<Catalog|undefined>(undefined);
  function restore(scope:BackendScope,view:View,steps:number) {
    if(!all.current?.backends.some(b=>b.backendId===scope.backendId&&b.projects.includes(scope.projectDirectory)))return false;
    setVisited(v=>v.some(s=>key(s)===key(scope))?v:[...v,scope]);setSelected(scope);
    setViews(v=>({...v,[key(scope)]:view}));setDepth(steps);return true;
  }
  useEffect(() => {
    const abort = new AbortController();
    void fetch("/api/backends", { signal: abort.signal }).then(async r => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const c: Catalog = await r.json();
      setCatalog(c);all.current=c;
      const stored=history.state?.teamflowView;
      if(!stored||!restore(stored.scope,stored.view,stored.steps)){
        restore(c.defaultScope,firstView,0);history.replaceState({...history.state,teamflowView:{scope:c.defaultScope,view:firstView,steps:0}},"");
      }
    }).catch(e => { if (!abort.signal.aborted) setError(String(e)); });
    const pop=(e:PopStateEvent)=>{const r=e.state?.teamflowView;if(r)restore(r.scope,r.view,r.steps)};
    window.addEventListener("popstate",pop);
    return () => {abort.abort();window.removeEventListener("popstate",pop)};
  }, []);
  function choose(scope: BackendScope,view:View=views[key(scope)]??firstView) {
    const old=history.state?.teamflowView;
    if(old&&key(old.scope)===key(scope)&&JSON.stringify(old.view)===JSON.stringify(view))return;
    const steps=(old?.steps??0)+1;
    if(restore(scope,view,steps))history.pushState({...history.state,teamflowView:{scope,view,steps}},"");
  }
  return <>
    <section className="project-strip" aria-label="工作地点"><div className="work-nav"><button disabled={!depth} onClick={()=>history.back()} title="回到刚才看的位置，不撤销已提交的操作">← 上一步</button><strong>工作空间</strong></div><div>
      <label>后端 <select aria-label="后端" value={selected?.backendId ?? ""} onChange={e => {
        const b = catalog?.backends.find(b => b.backendId === e.target.value);
        if (b) choose({ backendId: b.backendId, projectDirectory: b.projects[0]! });
      }}>{catalog?.backends.map(b => <option key={b.backendId}>{b.backendId}</option>)}</select></label>
      <label>项目 <select aria-label="项目" value={selected?.projectDirectory ?? ""} onChange={e => selected && choose({ ...selected, projectDirectory: e.target.value })}>
        {catalog?.backends.find(b => b.backendId === selected?.backendId)?.projects.map(p => <option key={p} value={p} title={p}>{p.split("/").filter(Boolean).at(-1) ?? p}</option>)}
       </select></label></div>
      {error && <p role="alert">{error}</p>}
    </section>
    {visited.map(scope => <div key={key(scope)} hidden={key(scope) !== (selected && key(selected))}>
      <Navigation.Provider value={{view:views[key(scope)]??firstView,go:v=>{if(key(scope)===key(history.state?.teamflowView?.scope??{} as BackendScope))choose(scope,v)}}}>{workspace(scope, key(scope) === (selected && key(selected)))}</Navigation.Provider>
    </div>)}
  </>;
}
