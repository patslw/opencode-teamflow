import { createHash } from "node:crypto";
import type { ServerResponse } from "node:http";
import type { EventSubscribeOutput, SessionInfo, SessionMessageInfo } from "@opencode/client";
import type { backendRegistry } from "./backends.js";
import type { LiveFrame, LiveItem, LiveStatus, ToolPhase } from "./session-stream-wire.js";

type Backend = Awaited<ReturnType<Awaited<ReturnType<typeof backendRegistry>>["select"]>>;
const eventTypes = [
  "rpc.teamflow.demo.changed",
  "session.deleted", "session.moved", "session.status", "session.idle",
  "session.execution.started", "session.execution.succeeded", "session.execution.failed", "session.execution.interrupted",
  "session.step.started", "session.reasoning.started", "session.reasoning.ended", "session.retry.scheduled",
  "session.text.started", "session.text.delta", "session.text.ended", "session.inbox.delivered",
  "session.tool.input.started", "session.tool.called", "session.tool.success", "session.tool.failed",
  "session.skill.activated", "session.shell.started", "session.shell.ended",
  "permission.asked", "permission.replied", "form.created", "form.replied", "form.cancelled",
] as const;
const labels = new Map<string, [string, string]>([
  ...["read", "read_file"].map(name => [name, ["读取文件", "读取内容不公开"]] as [string, [string, string]]),
  ["ls", ["列出目录", "目录内容不公开"]],
  ["glob", ["查找文件", "匹配模式与结果不公开"]], ["grep", ["搜索内容", "搜索条件与结果不公开"]],
  ["edit", ["编辑文件", "文件内容不公开"]], ["write", ["写入文件", "写入内容不公开"]],
  ["patch", ["应用补丁", "补丁内容不公开"]], ["apply_patch", ["应用补丁", "补丁内容不公开"]],
  ["bash", ["运行命令", "命令参数与输出不公开"]], ["shell", ["运行命令", "命令参数与输出不公开"]],
  ["execute", ["执行操作", "执行详情不公开"]], ["task", ["委派任务", "委派内容不公开"]],
  ["teamflow_command", ["执行团队操作", "操作参数不公开"]], ["teamflow_context", ["读取团队上下文", "上下文内容不公开"]],
  ["skill", ["加载 Skill", "技能正文不公开"]], ["question", ["提出问题", "请在对应的问题面板处理"]],
  ["webfetch", ["读取网页", "地址与内容不公开"]], ["websearch", ["搜索网页", "查询与结果不公开"]],
  ["todowrite", ["更新任务清单", "清单内容不公开"]], ["todoread", ["读取任务清单", "清单内容不公开"]],
]);
const keyFor = (...parts: (string | number)[]) => createHash("sha256").update(JSON.stringify(parts)).digest("base64url").slice(0, 22);
const textKey = (id: string, ordinal: number) => keyFor("reply", id, ordinal);
const textLimit = 48_000;

// The only free-form native body we accept is ordinary conversation. Apply
// best-effort redaction here too, including common credentials echoed in replies.
// Hold an unfinished ASCII token across deltas, so chunking cannot split a match.
function publicText(raw: string, streaming = false) {
  const redacted = raw.slice(0, textLimit + 512)
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[私钥已隐藏]")
    .replace(/(?<![\w-])(?:authorization|(?:[\w]+[-_])*(?:api[-_ ]?key|access[-_ ]?token|auth[-_ ]?token|refresh[-_ ]?token|password|secret|token))["'`]?\s*[:=][^\r\n]*/gi, "[凭据已隐藏]")
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_=.~-]+/gi, "[凭据已隐藏]")
    .replace(/https?:\/\/[^/\s:@]+:[^/\s@]+@/gi, "https://[凭据已隐藏]@")
    .replace(/\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{8,}|gh[pousr]_[a-zA-Z0-9_]{8,}|github_pat_[a-zA-Z0-9_]{8,}|AKIA[A-Z0-9]{16}|eyJ[\w-]+\.[\w-]+\.[\w-]+)\b/g, "[凭据已隐藏]");
  const visible = streaming ? redacted.replace(/[a-zA-Z0-9_./+@%:=?&~-]+$/, "") : redacted;
  return visible.length > textLimit ? `${visible.slice(0, textLimit)}\n[文本已截断]` : visible;
}

function tool(key: string, at: number, phase: ToolPhase, name?: string): LiveItem & { kind: "tool" } {
  const [label, summary] = labels.get(name ?? "") ?? ["调用工具", "仅公开执行状态"];
  return { key, at, kind: "tool", label, phase, summary };
}
function skill(at: number, name: unknown): LiveItem | undefined {
  // Only display the native skill name, not its ID/path/instructions.
  if (typeof name === "string" && /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/i.test(name) && name.length <= 64 &&
    publicText(name) === name) return { kind: "skill", key: keyFor("skill", name), at, name };
}
const outcomes = { succeeded: "idle", failed: "failed", interrupted: "stopped" } as const;
const precedence: Record<ToolPhase, number> = { preparing: 0, running: 1, done: 2, failed: 2, stopped: 2 };
const phaseOf = { streaming: "preparing", running: "running", completed: "done", error: "failed" } as const;
const missingNative = (error: unknown) => typeof error === "object" && error !== null && "_tag" in error && error._tag === "SessionNotFoundError";

function seed(messages: SessionMessageInfo[]) {
  const items = new Map<string, LiveItem>();
  const finalText = new Set<string>();
  function add(item?: LiveItem) { if (item && !items.has(item.key)) items.set(item.key, item); }
  for (const m of messages) {
    const at = m.time.created;
    if (m.type === "user" && m.text) add({ key: keyFor("user", m.id), at, kind: "user", text: publicText(m.text) });
    else if (m.type === "skill") add(skill(at, m.name));
    else if (m.type === "shell") {
      const phase = m.status === "running" ? "running" : m.status === "killed" ? "stopped"
        : m.status === "exited" && m.exit === 0 ? "done" : "failed";
      add({ ...tool(keyFor("shell", m.shellID), at, phase, "shell"), endedAt: m.time.completed });
    } else if (m.type === "assistant") {
      let ordinal = 0;
      for (const p of m.content) {
        if (p.type === "text") {
          // Native text ordinals count text parts, not tools or reasoning.
          const key = textKey(m.id, ordinal++);
          if (p.text || m.time.completed !== undefined) finalText.add(key);
          if (p.text) add({ key, at, kind: "reply", text: publicText(p.text) });
        } else if (p.type === "tool") {
          const phase = phaseOf[p.state.status];
          add({ ...tool(keyFor("tool", m.id, p.id), p.time?.created ?? at, phase, p.name), endedAt: p.time?.completed });
          if (p.name === "skill" && p.state.status === "completed") add(skill(at, p.state.metadata?.name));
        }
      }
    }
  }
  return { items, finalText };
}

function initialStatus(session: SessionInfo, active: boolean, messages: SessionMessageInfo[]): LiveStatus {
  if (active) {
    const step = messages.find(m => m.type === "assistant");
    if (step?.time.completed === undefined && !step?.content.some(p => p.type === "text" || p.type === "tool"))
      return "thinking";
    return "working";
  }
  const { busy, idle } = session.time;
  return idle !== undefined && (busy === undefined || idle >= busy) && session.outcome ? outcomes[session.outcome] : "unknown";
}

export async function streamSession(url: URL, response: ServerResponse, select: (url: URL, signal: AbortSignal) => Promise<Backend>) {
  const sessionID = url.searchParams.get("sessionId") ?? "";
  if (!/^ses_[a-zA-Z0-9_-]{1,96}$/.test(sessionID) || !url.searchParams.get("backendId") || !url.searchParams.get("projectDirectory")) {
    response.writeHead(400).end(); return;
  }
  const abort = new AbortController();
  const { signal } = abort;
  response.once("close", () => abort.abort());
  let lifetime: ReturnType<typeof setTimeout> | undefined;
  try {
    const { client, scope, options, isSessionRegistered } = await select(url, signal);
    if (signal.aborted) return;
    if (!await isSessionRegistered(sessionID, signal)) { response.writeHead(404).end(); return; }
    const opts = { ...options, signal };
    const request = { sessionID };
    // Native GET is global by session ID; never trust a successful lookup alone.
    async function belongsHere() {
      const s = await client.session.get(request, opts);
      return s.id === sessionID && s.location.directory === scope.projectDirectory ? s : undefined;
    }
    if (!await belongsHere()) { response.writeHead(404).end(); return; }
    // Reauthorize periodically even if the bus misses a registry change.
    lifetime = setTimeout(() => abort.abort(), 8 * 60_000);

    const upstream = client.event.subscribe({ types: [...eventTypes], signal })[Symbol.asyncIterator]();
    const handshake = await upstream.next();
    if (handshake.done || handshake.value.type !== "server.connected") throw new Error("Stream unavailable");

    const buffered: EventSubscribeOutput[] = [];
    let apply: ((event: EventSubscribeOutput) => void) | undefined;
    let invalid = false;
    function send(frame: LiveFrame) {
      if (signal.aborted || response.destroyed) return;
      response.write(`data: ${JSON.stringify(frame)}\n\n`);
      // A stuck client must not build an unbounded queue. Its next connection
      // reads the durable history again.
      if (response.writableLength > 4 * 1024 * 1024) abort.abort();
    }
    function revoke() {
      invalid = true;
      if (response.headersSent) send({ type: "unavailable" });
      if (!response.headersSent) response.writeHead(404);
      response.end();
      abort.abort();
    }
    const pump = (async () => {
      for (let next = await upstream.next(); !next.done && !signal.aborted; next = await upstream.next()) {
        const e = next.value;
        if (e.type === "server.connected") continue;
        const id = e.type === "form.created" ? e.data.form.sessionID : "sessionID" in e.data ? e.data.sessionID : undefined;
        if (e.type === "session.moved" && id === sessionID && e.data.location.directory !== scope.projectDirectory) { revoke(); break; }
        if (e.location?.directory !== scope.projectDirectory) continue;
        if (e.type === "rpc.teamflow.demo.changed") {
          if (!await isSessionRegistered(sessionID, signal)) { revoke(); break; }
          continue;
        }
        if (id !== sessionID) continue;
        if (e.type === "session.deleted") { revoke(); break; }
        if (apply) apply(e);
        else if (buffered.length < 4000) buffered.push(e);
        else break; // re-read instead of applying a truncated startup backlog
      }
    })().finally(() => abort.abort());
    // Observe early failure while the native snapshot is still loading.
    void pump.catch(() => {});

    const history = await client.message.list({ ...request, order: "desc", limit: 80 }, opts);
    const [native, active, forms, permissions] = await Promise.all([
      belongsHere(), client.session.active(opts).catch(() => undefined),
      client.session.form.list(request, opts).catch(() => []),
      client.permission.list(request, opts).catch(() => []),
    ]);
    if (!native) { revoke(); return; }
    if (invalid || signal.aborted) return;

    const { items, finalText } = seed(history.data.toReversed());
    // The native session form list contains pending forms only (FormInfo,
    // unlike the single-form detail endpoint, has no state field).
    const pendingForms = new Set(forms.filter(f => f.sessionID === sessionID).map(f => f.id));
    const pendingPermissions = new Set(permissions.filter(p => p.sessionID === sessionID).map(p => p.id));
    const awaiting = () => pendingForms.size > 0 || pendingPermissions.size > 0;
    let status = initialStatus(native, active?.[sessionID]?.type === "running", history.data);
    let terminalAt = status === "idle" || status === "stopped" || status === "failed" ? native.time.idle ?? 0 : 0;
    for (const [key, item] of items) {
      if (item.kind === "tool" && precedence[item.phase] < 2 && item.at <= terminalAt)
        items.set(key, { ...item, phase: "stopped", endedAt: terminalAt });
    }
    // A successful active query plus persisted busy newer than idle is not
    // sufficient evidence of running (e.g. after an unclean shutdown).
    let visible = awaiting() ? "waiting" as LiveStatus : status;
    const fragments = new Map<string, { raw: string; full: boolean }>();
    const publishStatus = (next = status) => {
      status = next;
      const value = awaiting() ? "waiting" : status;
      if (visible !== value) { visible = value; send({ type: "state", status: value }); }
    };
    function setItem(item: LiveItem) { items.set(item.key, item); send({ type: "item", item }); }
    function addSkill(at: number, name: unknown) {
      const item = skill(at, name);
      if (item && !items.has(item.key)) setItem(item);
    }
    function setTool(key: string, at: number, phase: ToolPhase, name?: string) {
      const old = items.get(key);
      if (old?.kind === "tool") {
        if (precedence[old.phase] >= precedence[phase]) return;
        setItem({ ...old, phase, endedAt: precedence[phase] === 2 ? at : undefined });
      } else setItem({ ...tool(key, at, phase, name), endedAt: precedence[phase] === 2 ? at : undefined });
    }
    function finish(status: "idle" | "stopped" | "failed", at: number) {
      for (const [key, item] of items) {
        if (item.kind === "tool" && precedence[item.phase] < 2) setTool(key, at, "stopped");
      }
      if (status !== "idle") { pendingForms.clear(); pendingPermissions.clear(); }
      fragments.clear();
      publishStatus(status);
    }
    const alive = (at: number, next: LiveStatus) => { if (at > terminalAt) publishStatus(next); };
    apply = e => {
      // The pump has already checked directory AND the actual ID field for
      // every event, including the nested form.created variant.
      if (e.type === "server.connected") return;
      const at = e.created;
      switch (e.type) {
        case "session.inbox.delivered":
          // Some TUI prompts are ordinary native user messages; never read or
          // publish synthetic Teamflow relay, system or instruction messages.
          void client.session.message.get({ ...request, messageID: e.data.inboxID }, opts).then(m => {
            if (m.type === "user" && m.text && !signal.aborted)
              setItem({ key: keyFor("user", m.id), at: m.time.created, kind: "user", text: publicText(m.text) });
          }).catch(() => {});
          break;
        case "session.execution.started": case "session.step.started": case "session.reasoning.started":
          alive(at, "thinking"); break;
        case "session.reasoning.ended": alive(at, "working"); break;
        case "session.retry.scheduled": alive(at, "waiting"); break;
        case "session.status":
          if (e.data.status.type === "retry") alive(at, "waiting");
          else if (e.data.status.type === "busy" && !["thinking", "working"].includes(status)) alive(at, "working");
          break;
        case "session.execution.failed": case "session.execution.interrupted": case "session.execution.succeeded":
          if (at >= terminalAt) {
            terminalAt = at;
            finish(e.type === "session.execution.failed" ? "failed" : e.type === "session.execution.interrupted" ? "stopped" : "idle", at);
          }
          break;
        case "session.idle":
          // Native also emits idle after terminal failure/interrupt; don't
          // let that transport-level idle erase the native execution outcome.
          if (at >= terminalAt && status !== "failed" && status !== "stopped") { terminalAt = at; finish("idle", at); }
          break;
        case "form.created": pendingForms.add(e.data.form.id); publishStatus(); break;
        case "form.replied": case "form.cancelled": pendingForms.delete(e.data.id); publishStatus(); break;
        case "permission.asked": pendingPermissions.add(e.data.id); publishStatus(); break;
        case "permission.replied": pendingPermissions.delete(e.data.requestID); publishStatus(); break;
        case "session.text.started": case "session.text.delta": case "session.text.ended": {
          alive(at, "working");
          const d = e.data;
          const key = textKey(d.assistantMessageID, d.ordinal);
          if (finalText.has(key)) break;
          if (e.type === "session.text.started") {
            if (!fragments.has(key)) fragments.set(key, { raw: "", full: true });
            break;
          }
          const old = items.get(key);
          if (e.type === "session.text.ended") {
            fragments.delete(key);
            finalText.add(key);
            setItem({ key, at: old?.at ?? at, kind: "reply", text: publicText(e.data.text) });
          } else {
            const fragment = fragments.get(key) ?? { raw: "", full: false };
            fragment.raw = (fragment.raw + e.data.delta).slice(0, textLimit + 512);
            fragments.set(key, fragment);
            const text = publicText(fragment.raw, true);
            if (old?.kind === "reply" && old.text === text) break;
            const item = { key, at: old?.at ?? at, kind: "reply" as const, text, partial: !fragment.full };
            if (old?.kind === "reply" && text.startsWith(old.text)) {
              items.set(key, item);
              send({ type: "append", key, text: text.slice(old.text.length) });
            } else if (text || old) setItem(item);
          }
          break;
        }
        case "session.tool.input.started": case "session.tool.called": case "session.tool.success": case "session.tool.failed": {
          alive(at, "working");
          const d = e.data;
          const key = keyFor("tool", d.assistantMessageID, d.id);
          const old = items.get(key);
          const phase = e.type === "session.tool.input.started" ? "preparing" : e.type === "session.tool.called" ? "running"
            : e.type === "session.tool.success" ? "done" : "failed";
          setTool(key, at, phase, e.type === "session.tool.input.started" ? e.data.name : undefined);
          if (e.type === "session.tool.success" && old?.kind === "tool" && old.label === "加载 Skill") addSkill(at, e.data.metadata?.name);
          break;
        }
        case "session.skill.activated": addSkill(at, e.data.name); break;
        case "session.shell.started": case "session.shell.ended": {
          alive(at, "working");
          const shell = e.data.shell;
          const phase = e.type === "session.shell.started" ? "running" : shell.status === "killed" ? "stopped"
            : shell.status === "exited" && shell.exit === 0 ? "done" : "failed";
          setTool(keyFor("shell", shell.id), at, phase, "shell");
          break;
        }
      }
    };

    response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "X-Accel-Buffering": "no" });
    send({ type: "snapshot", status: visible, items: [...items.values()], earlier: !!history.cursor?.next });
    for (const event of buffered.splice(0)) apply(event);
    await pump;
  } catch (error) {
    if (!response.headersSent && !response.destroyed)
      response.writeHead(missingNative(error) ? 404 : 503);
    else if (missingNative(error) && !response.destroyed)
      response.write(`data: ${JSON.stringify({ type: "unavailable" } satisfies LiveFrame)}\n\n`);
  } finally {
    if (lifetime) clearTimeout(lifetime);
    abort.abort();
    response.end();
  }
}
