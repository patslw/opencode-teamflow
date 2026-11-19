import type {
  BackendScope,
  MutationEnvelope,
  MutationResult,
  TeamflowCommand,
  TeamflowSnapshot,
} from "../../../packages/protocol/src/index.js";
import {
  MutationRetry,
  MutationRejectedError,
} from "../../../plugin/src/mutation-retry.js";
export { MutationRejectedError };

// The endpoint is a same-origin host identifier, never an upstream URL.
export type BackendProfile = {
  backendId: string;
  endpoint: "same-origin";
  projectDirectory: string;
};
export type TeamflowConnection = {
  refresh(): Promise<TeamflowSnapshot | undefined>;
  mutate(command: TeamflowCommand): Promise<MutationResult>;
  retryMutation(): Promise<MutationResult>;
  forgetMutation(): Promise<void>;
  pendingMutation(): MutationEnvelope | undefined;
  sessionMessages(sessionId: string): Promise<unknown[]>;
  sessionSend(sessionId: string, text: string): Promise<unknown>;
  close(): void;
};

export function connectBackend(
  profile: BackendProfile,
  onSnapshot: (snapshot: TeamflowSnapshot) => void,
  onConnection: (status: string) => void,
  onPending: (envelope: MutationEnvelope | undefined) => void,
): TeamflowConnection {
  const scope: BackendScope = {
    backendId: profile.backendId,
    projectDirectory: profile.projectDirectory,
  };
  if (profile.endpoint !== "same-origin") throw new Error("未配置该网页端点");
  const controller = new AbortController();
  let closed = false;
  let snapshot: TeamflowSnapshot | undefined;
  let sequence = 0;
  let appliedSequence = 0;
  const query = new URLSearchParams(scope);
  const scopedPath = (path: string) => `${path}${path.includes("?") ? "&" : "?"}${query}`;
  const events = new EventSource(scopedPath("/api/events"));
  async function request<T>(path: string, input?: unknown): Promise<T> {
    if (closed) throw new Error("连接已关闭；未发送");
    const response = await fetch(scopedPath(path), {
      signal: controller.signal,
      ...(input === undefined
        ? {}
        : {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(input),
          }),
    });
    const data = await response.json();
    if (!response.ok) {
      if (path === "/api/mutate" && data.outcome === "rejected")
        throw new MutationRejectedError(data.error ?? "后端明确拒绝");
      throw new Error(data.error ?? `HTTP ${response.status}`);
    }
    if (closed) throw new Error("连接已关闭，忽略旧响应");
    return data as T;
  }
  async function refresh() {
    const current = ++sequence;
    const result = await request<TeamflowSnapshot>("/api/snapshot");
    if (closed) return;
    if (
      result.scope.backendId !== scope.backendId ||
      result.scope.projectDirectory !== scope.projectDirectory
    ) {
      throw new Error("后端或项目身份不匹配");
    }
    if (
      !snapshot ||
      result.revision > snapshot.revision ||
      (result.revision === snapshot.revision && current > appliedSequence)
    ) {
      snapshot = result;
      appliedSequence = current;
      onSnapshot(result);
    }
    onConnection(
      events.readyState === EventSource.OPEN
        ? "已连接"
        : "快照已同步；事件重连中",
    );
    return snapshot;
  }
  const refreshVisible = () =>
    void refresh().catch((error) => {
      if (!closed) onConnection(`同步失败：${String(error)}`);
    });
  events.addEventListener("connected", () => {
    if (!closed) {
      onConnection("已连接");
      refreshVisible();
    }
  });
  events.addEventListener("changed", refreshVisible);
  events.onerror = () => {
    if (!closed) onConnection("连接断开，状态待同步");
  };
  const timer = setInterval(refreshVisible, 5000);
  const storageKey = `teamflow.pending:${JSON.stringify(scope)}`;
  let journal: MutationRetry;
  try {
    const saved = localStorage.getItem(storageKey);
    journal = new MutationRetry(
      scope,
      async (envelope) => {
        const result = await request<MutationResult>("/api/mutate", envelope);
        // Replay snapshots may be old. Re-read authority, and retain the journal
        // if this connection is disposed before handing the result to the UI.
        await refresh().catch((error) => {
          if (closed) throw error;
          onConnection(`变更已返回；重读失败：${String(error)}`);
        });
        if (closed) throw new Error("连接已关闭，保留原提交身份待核对");
        return result;
      },
      saved ? JSON.parse(saved) : undefined,
      (envelope, expectedRequestId) => {
        const existing = localStorage.getItem(storageKey);
        if (existing && JSON.parse(existing).requestId !== expectedRequestId)
          throw new Error(
            "同一后端/项目已有另一未决操作；请重新连接读取并处理，不能覆盖原身份",
          );
        if (envelope)
          localStorage.setItem(storageKey, JSON.stringify(envelope));
        else localStorage.removeItem(storageKey);
        if (!closed) onPending(envelope);
      },
    );
    onPending(journal.pending);
  } catch (error) {
    closed = true;
    controller.abort();
    events.close();
    clearInterval(timer);
    throw error;
  }
  refreshVisible();
  return {
    refresh,
    async mutate(command) {
      if (closed) throw new Error("连接已关闭；未发送");
      if (!snapshot) throw new Error("尚未同步项目状态");
      return journal.submit(snapshot.revision, command);
    },
    retryMutation: () => { if (closed) throw new Error("连接已关闭；未重试"); return journal.retry(); },
    forgetMutation: () => journal.forget(),
    pendingMutation: () => journal.pending,
    sessionMessages: (sessionId) =>
      request(
        `/api/session/messages?sessionId=${encodeURIComponent(sessionId)}`,
      ),
    sessionSend: (sessionId, text) =>
      request("/api/session/send", { sessionId, text }),
    close() {
      closed = true;
      controller.abort();
      events.close();
      clearInterval(timer);
    },
  };
}
