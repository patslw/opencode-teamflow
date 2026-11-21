import React,{useEffect,useState} from "react";
import type { TeamflowMessage } from "../../../packages/protocol/src/index";
import type { TeamflowConnection } from "./connection";
import { ChatText } from "./ChatText";

// Render only the reply window belonging to this public follow-up. Other
// admissions (including a private message) close it, as does native turn end.
export function ProposalFollowup({msg,sessionId,connection,active}:{msg:TeamflowMessage;sessionId?:string;connection?:TeamflowConnection;active:boolean}) {
  const [texts,set]=useState<string[]>([]),[error,fail]=useState("");
  useEffect(()=>{let live=true,busy=false;set([]);fail("");
    if(!sessionId||!connection||!active)return;
    async function read(){if(busy)return;busy=true;try{
      const raw=await connection!.sessionMessages(sessionId!);let window=false;const replies:string[]=[];
      for(const r of raw as Record<string,any>[]){const type=r.type??r.info?.role??r.role;
        if(["user","synthetic","idle","system"].includes(type)){window=(r.id??r.info?.id)===msg.id;continue}
        if(!window||type!=="assistant")continue;
        const pieces=(r.content??r.parts??[]).filter((x:any)=>x.type==="text"&&!x.synthetic&&!x.ignored).map((x:any)=>x.text).filter(Boolean);
        if(pieces.length)replies.push(pieces.join("\n"));else if(r.error)replies.push("这次回复失败，请在成员会话中查看原因。");
      }if(live){set(replies);fail("")}
    }catch{if(live)fail("暂时读不到负责人会话。")}finally{busy=false}}
    void read();const timer=setInterval(read,4000);return()=>{live=false;clearInterval(timer)};
  },[msg.id,connection,sessionId,active]);
  return <div className="proposal-followup"><small>方案讨论 · 我</small><ChatText text={msg.text}/>
    {texts.length?<><b>负责人</b>{texts.map((text,i)=><ChatText text={text} key={i}/>)}</>:<small>{error||(["cancelled","undelivered","uncertain"].includes(msg.status)?"这条追问尚未确认送达。":"尚未收到这条追问的回复。")}</small>}</div>;
}
