import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { BackendScope, TeamflowSnapshot } from "../../../packages/protocol/src/index.js";
import type { LiveFrame, LiveItem, LiveStatus, ToolPhase } from "../../web-host/src/session-stream-wire.js";
import "./live-session.css";

type Props = {
  scope: BackendScope;
  sessionId: string;
  active: boolean;
  who: string;
  sent?: Pick<TeamflowSnapshot["messages"][number], "id" | "text" | "createdAt">[];
};
type Progress = {
  connection: "opening" | "live" | "reconnecting" | "unavailable";
  status: LiveStatus;
  items: Map<string, LiveItem>;
  earlier: boolean;
};
const empty: Progress = { connection: "opening", status: "unknown", items: new Map(), earlier: false };
const statuses: Record<LiveStatus, string> = {
  unknown: "状态未知", idle: "空闲", thinking: "正在思考", working: "正在工作",
  waiting: "正在等待", stopped: "已停止", failed: "出错",
};
const phases: Record<ToolPhase, string> = {
  preparing: "准备中", running: "执行中", done: "已完成", failed: "失败", stopped: "已停止",
};
const clock = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" });

function update(state: Progress, frame: LiveFrame): Progress {
  switch (frame.type) {
    case "snapshot":
      return { connection: "live", status: frame.status, items: new Map(frame.items.map(item => [item.key, item])), earlier: frame.earlier };
    case "state": return { ...state, status: frame.status };
    case "unavailable": return { ...empty, connection: "unavailable" };
    case "item": {
      const items = new Map(state.items);
      items.set(frame.item.key, frame.item);
      return { ...state, items };
    }
    case "append": {
      const item = state.items.get(frame.key);
      if (item?.kind !== "reply") return state;
      const items = new Map(state.items);
      items.set(frame.key, { ...item, text: item.text + frame.text });
      return { ...state, items };
    }
  }
}

export function LiveSession({ active, scope, sessionId, who, sent }: Props) {
  if (!active || !sessionId) return null;
  const query = new URLSearchParams({ ...scope, sessionId });
  // Remount by scope and native ID before the old effect can render in a new chat.
  const endpoint = `/api/session/live?${query}`;
  return <LiveSessionView key={endpoint} endpoint={endpoint} who={who} sent={sent} />;
}

function LiveSessionView({ endpoint, who, sent }: { endpoint: string; who: string; sent?: Props["sent"] }) {
  const [progress, setProgress] = useState(empty);
  const [following, setFollowing] = useState(true);
  const timeline = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const box = timeline.current;
    if (following && box) box.scrollTop = box.scrollHeight;
  }, [progress.items, sent, following]);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    const unavailable = () => setProgress({ ...empty, connection: "unavailable" });
    async function connect() {
      try {
        const r = await fetch(endpoint, { signal: controller.signal, headers: { Accept: "text/event-stream" } });
        if (controller.signal.aborted) return;
        if ([400, 401, 403, 404].includes(r.status)) { unavailable(); return; }
        if (!r.ok || !r.body || !r.headers.get("Content-Type")?.startsWith("text/event-stream")) throw new Error();
        const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffered = "";
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (controller.signal.aborted || done) break;
            buffered += value;
            let boundary: number;
            while ((boundary = buffered.indexOf("\n\n")) !== -1) {
              const record = buffered.slice(0, boundary);
              buffered = buffered.slice(boundary + 2);
              if (!record.startsWith("data: ")) continue;
              const frame = JSON.parse(record.slice(6)) as LiveFrame;
              if (frame.type === "snapshot") failures = 0;
              setProgress(old => update(old, frame));
              if (frame.type === "unavailable") return;
            }
            if (buffered.length > 12 * 1024 * 1024) throw new Error();
          }
        } finally {
          void reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      } catch {
        // Only report a fixed connection status, not upstream error text.
      }
      if (controller.signal.aborted) return;
      setProgress(old => ({ ...old, connection: "reconnecting", status: "unknown" }));
      timer = setTimeout(connect, Math.min(15_000, 800 * 2 ** Math.min(failures++, 5)));
    }
    void connect();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [endpoint]);

  const status = progress.connection === "live" ? progress.status : "unknown";
  const connectionText = progress.connection === "opening" ? "正在读取 OpenCode 会话"
    : progress.connection === "reconnecting" ? "连接中断，正在重新读取"
    : progress.connection === "unavailable" ? "原生会话不可用，或不属于当前项目" : undefined;
  const items = [...progress.items.values()];
  const skills = items.filter(item => item.kind === "skill");
  const conversation: LiveItem[] = [
    ...items.filter(item => item.kind !== "skill"),
    ...(sent ?? []).map(message => ({
      key: `sent:${message.id}`, at: Date.parse(message.createdAt), kind: "user" as const, text: message.text,
    })),
  ].sort((a, b) => (a.at || 0) - (b.at || 0));

  return <section className="live-session" aria-label={`${who}的 OpenCode 会话`}>
    <div className="live-session-head">
      <span className="live-session-caption">OpenCode 会话</span>
      <span className={`live-session-state ${status}`} role="status">{statuses[status]}</span>
    </div>
    {connectionText && <p className="live-session-note" role={progress.connection === "unavailable" ? "alert" : undefined}>{connectionText}</p>}
    {!!skills.length && <div className="live-session-skills"><span>已加载 Skill</span>{skills.map(item => <span key={item.key}>{item.name}</span>)}</div>}
    {progress.earlier && <p className="live-session-note">仅显示最近的会话记录</p>}
    {!conversation.length && progress.connection === "live" && <p className="live-session-note">还没有可显示的对话或工具记录。</p>}
    {!following && <button className="live-session-latest" type="button" onClick={() => setFollowing(true)}>回到最新</button>}
    <div className="live-session-timeline" ref={timeline} tabIndex={conversation.length ? 0 : undefined} aria-label="会话详情"
      onScroll={event => {
        const box = event.currentTarget;
        setFollowing(box.scrollHeight - box.scrollTop - box.clientHeight < 40);
      }}>
      {conversation.map(item => item.kind === "tool"
        ? <details key={item.key} className="live-session-tool">
          <summary><strong>{item.label}</strong><span className={item.phase}>{phases[item.phase]}</span></summary>
          <div>{item.summary}{item.at > 0 && <><span aria-hidden> · </span><time>{clock.format(item.at)}</time>
            {item.endedAt && <> – <time>{clock.format(item.endedAt)}</time></>}</>}</div>
        </details>
        : item.kind !== "skill" && <article key={item.key} className={`live-session-post ${item.kind}`}>
          <div><strong>{item.kind === "user" ? "我" : who}</strong>{item.at > 0 && <time>{clock.format(item.at)}</time>}</div>
          {item.partial && <div className="live-session-note">仅显示接入后收到的片段</div>}
          <p>{item.text}</p>
        </article>)}
    </div>
  </section>;
}
