import React, { useEffect, useState } from "react";
import type { BackendScope, WorkflowNode } from "../../../packages/protocol/src/index";

export type Catalog = {skills:{id:string;name:string;description?:string}[];tools:{id:string;description?:string}[]};
const labels: Record<string,string>={question:"向用户提问",skill:"使用技能",read:"读取文件",glob:"查找文件",grep:"搜索内容",shell:"运行终端命令",edit:"编辑文件",patch:"修改文件",webfetch:"读取网页"};
export function StageSettings({scope,node,update,readOnly}:{scope:BackendScope;node:WorkflowNode;update(v:Partial<WorkflowNode>):void;readOnly:boolean}){
  const [catalog,set]=useState<Catalog>(),[err,error]=useState(""),[filter,search]=useState("");
  useEffect(()=>{const c=new AbortController();set(undefined);error("");
    void fetch(`/api/capabilities?${new URLSearchParams(scope)}`,{signal:c.signal}).then(async r=>{const v=await r.json();if(!r.ok)throw new Error(v.error??r.statusText);if(!c.signal.aborted)set(v)}).catch(e=>{if(!c.signal.aborted)error(String(e))});return()=>c.abort()
  },[scope.backendId,scope.projectDirectory]);
  const selectedSkills=node.skills??[], selectedTools=node.tools??[];
  const toggle=(key:"skills"|"tools",id:string)=>{const old=node[key]??[];update({[key]:old.includes(id)?old.filter(i=>i!==id):[...old,id]})};
  const list=(key:"skills"|"tools")=>{
    const chosen=key==="skills"?selectedSkills:selectedTools;
    const entries=(catalog?.[key]??[]).map(x=>({id:x.id,name:"name" in x?String(x.name):labels[x.id]??x.id}));
    for(const id of chosen)if(!entries.some(x=>x.id===id))entries.push({id,name:id});
    return <div className="cap-list">{entries.filter(x=>chosen.includes(x.id)||`${x.name} ${x.id}`.toLowerCase().includes(filter.toLowerCase())).map(x=><label key={x.id}><input type="checkbox" disabled={readOnly||!catalog} checked={chosen.includes(x.id)} onChange={()=>toggle(key,x.id)}/>{x.name}{x.name!==x.id&&<small>{x.id}</small>}</label>)}</div>;
  };
  return <fieldset className="stage-settings"><legend>这个阶段怎样工作</legend>
    <p>技能是工作方法，工具是实际能调用的能力。只改变这个阶段，不会给成员增加宿主未授权的权限。</p>
    <label>查找本项目已安装的能力<input value={filter} onChange={e=>search(e.target.value)} placeholder="例如 brainstorming 或 question"/></label>
    {err?<p role="alert">无法读取当前项目的能力目录。{err}</p>:!catalog&&<p>正在读取已安装的技能和工具…</p>}
    <h3>阶段技能</h3><label><input type="checkbox" disabled={readOnly} checked={node.skills!==undefined} onChange={e=>update({skills:e.target.checked?[]:undefined})}/>单独设置这个阶段的技能</label>
    {node.skills!==undefined?list("skills"):<p>沿用这个角色的技能设置。</p>}
    <h3>阶段工具</h3><label><input type="checkbox" disabled={readOnly} checked={node.tools!==undefined} onChange={e=>update({tools:e.target.checked?[]:undefined})}/>只使用我选择的工具</label>
    {node.tools!==undefined?list("tools"):<p>使用角色和宿主允许的默认工具。</p>}
    {node.tools?.length===0&&<small>未选择额外业务工具。成员仍可使用 Teamflow 的协作能力。</small>}
  </fieldset>;
}
