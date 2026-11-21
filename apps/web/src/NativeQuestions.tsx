import React,{useEffect,useRef,useState} from "react";
import type {BackendScope} from "../../../packages/protocol/src/index";
import type {NativeForm} from "../../../packages/protocol/src/rpc";

export function useNativeQuestions(scope:BackendScope,runIds:string[],active:boolean){
  const key=JSON.stringify([...new Set(runIds)].sort());
  const [forms,set]=useState<NativeForm[]>([]),[error,setError]=useState(""),[cycle,bump]=useState(0);
  useEffect(()=>{const c=new AbortController();let loading=false;set([]);setError("");
    const ids:string[]=JSON.parse(key);
    if(!active||!ids.length)return()=>c.abort();
    const load=async()=>{if(loading)return;loading=true;const found:NativeForm[]=[];const bad:string[]=[];
      try{for(let i=0;i<ids.length&&!c.signal.aborted;i+=3){
        await Promise.all(ids.slice(i,i+3).map(async runId=>{try{
          const res=await fetch(`/api/native-forms?${new URLSearchParams({...scope,runId})}`,{signal:c.signal});const body=await res.json();
          if(!res.ok||!Array.isArray(body))throw new Error(body.error||"无法读取原生提问");
          found.push(...body.filter((f:NativeForm)=>f.runId===runId));
        }catch(e){bad.push(String(e))}}))
      }if(!c.signal.aborted){set(found);setError(bad.length?"有成员的 OpenCode 提问暂时无法读取。":"")}}finally{loading=false}};
    void load();const timer=setInterval(load,3500);return()=>{c.abort();clearInterval(timer)};
  },[scope.backendId,scope.projectDirectory,key,active,cycle]);
  return {forms,error,refresh:()=>bump(i=>i+1)};
}
type Answer=Record<string,string|number|boolean|string[]>;
export function NativeQuestion({f,scope,refresh}:{f:NativeForm;scope:BackendScope;refresh:()=>void}){
  const [answer,set]=useState<Answer>(()=>Object.fromEntries(f.fields.flatMap(x=>x.default===undefined?[]:[[x.key,x.default] as const]))),[err,error]=useState(""),[busy,wait]=useState(false);
  const lock=useRef(false);
  const visible=f.fields.filter(x=>!x.hidden&&(!Array.isArray(x.when)||x.when.every(cond=>cond.op==="eq"?answer[cond.key]===cond.value:answer[cond.key]!==cond.value)));
  const change=(key:string,v:Answer[string])=>set(old=>({...old,[key]:v}));
  async function send(e:React.FormEvent){e.preventDefault();if(lock.current)return;lock.current=true;wait(true);error("");
    try{const values=Object.fromEntries(visible.filter(x=>Object.hasOwn(answer,x.key)).map(x=>[x.key,answer[x.key]]));
      const res=await fetch(`/api/native-form-reply?${new URLSearchParams(scope)}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({scope,formId:f.formId,runId:f.runId,taskId:f.taskId,sessionId:f.sessionId,attemptId:f.attemptId,answer:values})});
      const v=await res.json();if(!res.ok||!v.accepted)throw new Error(v.error??"未确认送达");refresh();
    }catch(e){error(`未确认送达，未自动重发。${String(e)}`);lock.current=false;wait(false)}
  }
  return <form className="native-card" id={`native-${f.formId}`} onSubmit={send}><small>成员正在使用 OpenCode 提问</small><h3>{f.title}</h3>
    {visible.map(x=><fieldset key={x.key}><legend>{x.title??x.key}</legend>{x.description&&<p>{x.description}</p>}
      {x.options?.map(o=><label className="native-choice" key={o.value}><input type={x.type==="multiselect"?"checkbox":"radio"} name={`${f.formId}-${x.key}`}
        checked={Array.isArray(answer[x.key])?(answer[x.key] as string[]).includes(o.value):answer[x.key]===o.value}
        onChange={()=>{if(x.type!=="multiselect")change(x.key,o.value);else{const arr=Array.isArray(answer[x.key])?answer[x.key] as string[]:[];change(x.key,arr.includes(o.value)?arr.filter(v=>v!==o.value):[...arr,o.value])}}}/>{o.label}{o.description&&<small> · {o.description}</small>}</label>)}
      {x.type==="boolean"?<select aria-label={x.title??x.key} value={answer[x.key]===undefined?"":String(answer[x.key])} onChange={e=>change(x.key,e.target.value==="true")} required={x.required}><option value="">请选择</option><option value="true">是</option><option value="false">否</option></select>:
        x.type==="external"?<p>这个问题需在原生 OpenCode 会话中处理。</p>:
        x.type==="multiselect"&&x.custom?<label>其他答案（每行一项）<textarea value={(Array.isArray(answer[x.key])?answer[x.key] as string[]:[]).filter(v=>!x.options?.some(o=>o.value===v)).join("\n")} onChange={e=>{const selected=(Array.isArray(answer[x.key])?answer[x.key] as string[]:[]).filter(v=>x.options?.some(o=>o.value===v));change(x.key,[...selected,...e.target.value.split("\n")])}}/></label>:
        (!x.options?.length||x.custom)&&x.type!=="multiselect"?<label>{x.options?.length?"也可以自己填写":"你的回答"}<input required={x.required} type={["integer","number"].includes(x.type)?"number":"text"} step={x.type==="integer"?1:"any"} value={String(answer[x.key]??"")} onChange={e=>change(x.key,["integer","number"].includes(x.type)&&e.target.value!==""?Number(e.target.value):e.target.value)}/></label>:null}
    </fieldset>)}{err&&<p role="alert">{err}</p>}<button className="desk-primary" disabled={busy||visible.some(x=>x.type==="external"||(x.required&&(answer[x.key]===undefined||answer[x.key]===""||Array.isArray(answer[x.key])&&!(answer[x.key] as string[]).length)))}>发送给提问成员</button>
  </form>;
}
