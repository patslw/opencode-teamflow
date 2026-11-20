import React from "react";

// Render only ordinary text, emphasis and lists. Never inject model-generated HTML.
export function ChatText({text}:{text:string}) {
  const inline=(s:string)=>s.split(/(\*\*[^*\n]+\*\*|`[^`\n]+`)/g).map((x,i)=>x.startsWith("**")&&x.endsWith("**")?<strong key={i}>{x.slice(2,-2)}</strong>:x.startsWith("`")&&x.endsWith("`")?<span key={i}>{x.slice(1,-1)}</span>:x);
  const paragraphs=text.split(/\n+|(?<=。)(?=(?:建议方案|备选方案|推荐|Demo 验收|验收方式|无阻塞|排除))/u).map(s=>s.trim()).filter(Boolean);
  return <div className="chat-copy">{paragraphs.map((s,i)=><p key={i}>{inline(s.replace(/^[-*] /,"• "))}</p>)}</div>;
}
