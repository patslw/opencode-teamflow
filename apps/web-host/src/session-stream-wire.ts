// The browser only receives this projection, never native OpenCode objects.
export type LiveStatus = "unknown" | "idle" | "thinking" | "working" | "waiting" | "stopped" | "failed";
export type ToolPhase = "preparing" | "running" | "done" | "failed" | "stopped";
export type LiveItem = { key: string; at: number } & (
  | { kind: "reply" | "user"; text: string; partial?: boolean }
  | { kind: "tool"; label: string; phase: ToolPhase; summary?: string; endedAt?: number }
  | { kind: "skill"; name: string }
);
export type LiveFrame =
  | { type: "snapshot"; status: LiveStatus; items: LiveItem[]; earlier: boolean }
  | { type: "state"; status: LiveStatus }
  | { type: "item"; item: LiveItem }
  | { type: "append"; key: string; text: string }
  | { type: "unavailable" };
