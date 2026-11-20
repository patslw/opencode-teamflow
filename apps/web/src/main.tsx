import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  MarkerType,
} from "@xyflow/react";
import type { Connection } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "./style.css";
import { CollaborationPanel } from "./CollaborationPanel";
import { DraftView } from "./DraftView";
import { PatchView } from "./PatchView";
import { BackendChooser } from "./BackendChooser";
import { TeamDesk } from "./TeamDesk";
import {
  connectBackend,
  MutationRejectedError,
  type TeamflowConnection,
} from "./connection";
import type {
  BackendScope,
  TeamflowSnapshot,
  TeamflowCommand,
  MutationResult,
  MutationEnvelope,
  WorkflowVersion,
  WorkflowNode,
  WorkflowRole,
  StageAttempt,
  Member,
  Run,
  Task,
} from "../../../packages/protocol/src/index";
import {
  VersionSchema,
  TemplateSchema,
} from "../../../packages/protocol/src/index";

const statusNames: Record<string, string> = {
  running: "运行中",
  waiting: "等待你确认 / 检查",
  paused: "已暂停",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
  pending: "待前置完成",
  ready: "就绪",
  awaiting_gate: "等待批准",
  passed: "已通过",
  needs_revision: "需要返工",
  superseded: "已失效",
  uncertain: "派工不确定",
  bound: "已绑定",
  submitted: "已提交",
  intent: "派工意图",
};
const label = (status: string) => statusNames[status] ?? status;
const lines = (value: string) =>
  value
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean);
const pretty = (value: unknown) => JSON.stringify(value, null, 2);
const currentAttempt = (s: TeamflowSnapshot, runId: string, nodeId: string) =>
  s.attempts
    .filter((a) => a.runId === runId && a.nodeId === nodeId)
    .sort((a, b) => b.round - a.round)[0];
function Field({
  title,
  value,
  onChange,
  multiline = false,
  disabled = false,
}: {
  title: string;
  value: string;
  onChange?: (v: string) => void;
  multiline?: boolean;
  disabled?: boolean;
}) {
  // Keep raw newlines while typing array-backed fields (their protocol value is normalized).
  const [raw, setRaw] = useState(value);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setRaw(value);
  }, [value]);
  const props = {
    value: onChange ? raw : value,
    readOnly: !onChange,
    disabled,
    onFocus: () => {
      focused.current = true;
    },
    onBlur: () => {
      focused.current = false;
      setRaw(value);
    },
    onChange: (
      e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
    ) => {
      setRaw(e.target.value);
      onChange?.(e.target.value);
    },
  };
  return (
    <label className="field">
      <span>{title}</span>
      {multiline ? <textarea {...props} /> : <input {...props} />}
    </label>
  );
}
type Mutate = (command: TeamflowCommand) => Promise<MutationResult | undefined>;
function useEditorState<T>(initial: T, epoch: React.RefObject<number>) {
  const [value, setValue] = useState(initial);
  const update: React.Dispatch<React.SetStateAction<T>> = (next) => {
    epoch.current++;
    setValue(next);
  };
  return [value, update] as const;
}

function App({ selectedScope, active }: { selectedScope: BackendScope; active: boolean }) {
  const editorEpoch = useRef(0);
  const [snapshot, setSnapshot] = useState<TeamflowSnapshot>();
  const [scope, setScope] = useState<BackendScope>();
  const [connectionState, setConnectionState] = useState("正在连接");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState(false);
  const [unresolved, setUnresolved] = useState<MutationEnvelope>();
  const [versionId, setVersionId] = useEditorState("", editorEpoch);
  const [runId, setRunId] = useEditorState("", editorEpoch);
  const [studio,setStudio] = useState(false);
  const [studioTab,setStudioTab]=useState<"discuss"|"graph"|"start">("discuss");
  const [nodeId, setNodeId] = useEditorState("", editorEpoch);
  const [memberId, setMemberId] = useEditorState("", editorEpoch);
  const [draft, setDraft] = useEditorState<WorkflowVersion | undefined>(
    undefined,
    editorEpoch,
  );
  const [draftPanelInput, setDraftPanelInput] = useState(false);
  const [draftPanelText, setDraftPanelText] = useEditorState("", editorEpoch);
  const [runLabel, setRunLabel] = useEditorState("", editorEpoch);
  const [brief, setBrief] = useEditorState("", editorEpoch);
  const [slots, setSlots] = useEditorState(4, editorEpoch),
    [depth, setDepth] = useEditorState(2, editorEpoch),
    [reworks, setReworks] = useEditorState(3, editorEpoch);
  const [edgeKind, setEdgeKind] = useState<"normal" | "return">("normal");
  const [selectedEdge, setSelectedEdge] = useState<number>();
  const [importText, setImportText] = useEditorState("", editorEpoch);
  const mutationLock = useRef(false);
  useEffect(() => {
    if (!draft && !draftPanelText) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [draft, draftPanelText]);
  const connection = useRef<TeamflowConnection | undefined>(undefined);
  const generation = useRef(0);
  const [reconnect, setReconnect] = useState(0);
  useEffect(() => {
    if (!active) return;
    const gen = ++generation.current;
    const abort = new AbortController();
    setPending(false);
    setConnectionState("正在连接");
    mutationLock.current = false;
    fetch(`/api/info?${new URLSearchParams(selectedScope)}`, { signal: abort.signal })
      .then(async (res) => {
        const info = await res.json();
        if (!res.ok) throw new Error(info.error ?? `HTTP ${res.status}`);
        if (gen !== generation.current) return;
        setScope(info.scope);
        connection.current = connectBackend(
          { ...info.scope, endpoint: "same-origin" },
          (s) => {
            if (gen === generation.current) setSnapshot(s);
          },
          (state) => {
            if (gen === generation.current) setConnectionState(state);
          },
          (envelope) => {
            if (gen === generation.current) setUnresolved(envelope);
          },
        );
      })
      .catch((e) => {
        if (!abort.signal.aborted) {
          setError(String(e));
          setConnectionState("连接失败");
        }
      });
    return () => {
      generation.current++;
      editorEpoch.current++;
      abort.abort();
      connection.current?.close();
      connection.current = undefined;
    };
  }, [reconnect, active, selectedScope]);
  const run = snapshot?.runs.find((r) => r.id === runId);
  const published =
    snapshot?.versions.find((v) => v.id === (run?.versionId ?? versionId)) ??
    (!versionId && !runId ? snapshot?.versions[0] : undefined);
  const version = draft ?? published;
  const edgeIdentity = JSON.stringify([
    runId,
    version?.id,
    version?.graph.edges,
  ]);
  useEffect(() => {
    setSelectedEdge(undefined);
  }, [edgeIdentity]);
  const node = version?.graph.nodes.find((n) => n.id === nodeId);
  const member = snapshot?.members.find((m) => m.id === memberId);
  const attempt =
    snapshot && run && node
      ? currentAttempt(snapshot, run.id, node.id)
      : undefined;
  const performMutation = async (command: TeamflowCommand, retry = false) => {
    if (!connection.current || mutationLock.current) return;
    mutationLock.current = true;
    const gen = generation.current;
    setPending(true);
    setError("");
    setNotice("");
    try {
      const result = await (retry
        ? connection.current.retryMutation()
        : connection.current.mutate(command));
      if (gen !== generation.current) return;
      if (result.inProgress)
        setNotice(
          `操作未确认完成 / 未排队：${result.inProgress.reason}；进行中 requestId=${result.inProgress.requestId}。保留输入，刷新后显式重新核对。`,
        );
      else if (command.type === "dispatch.reconcile") {
        const task = result.snapshot.tasks.find(
          (t) => t.id === command.payload.taskId,
        );
        setNotice(
          `任务核对：${(command.payload.action === "inspect" ? task?.inspection : task?.reconciliation)?.evidence.join("；") || "暂时无法确认执行状态。"}`,
        );
      } else if (command.type === "message.reconcile") {
        const task = result.snapshot.tasks.find(t => t.messageInspection?.messageId === command.payload.messageId || t.messageRecovery?.messageId === command.payload.messageId);
        const recovery = command.payload.action === "inspect" ? task?.messageInspection : task?.messageRecovery;
        setNotice(command.payload.action === "adopt" ? "用户已显式授权未发出的旧意图继续；尚非原生接收或处理确认。" : `消息据证核对（不是重发或自动解锁）：${recovery?.evidence.join("；") || "暂无新证据"}`);
      } else
        setNotice(
          `后端已提交 ${command.type}${command.type === "run.start" ? ` · runId=${command.payload.runId}` : command.type === "template.import" ? ` · version=${command.payload.version.id}` : ""} · revision ${result.revision}${result.resyncRequired ? "；通知未送达，已重新读取快照" : ""}`,
        );
      return result;
    } catch (e) {
      if (gen === generation.current)
        setError(
          e instanceof MutationRejectedError
            ? `后端明确拒绝（未提交）：${String(e)}。输入已保留，可比较后显式发起新操作。`
            : connection.current?.pendingMutation()
              ? `提交结果未知 / 未决操作仍保留：${String(e)}。不能视为未提交；请核对或按原身份重试，不要重复启动。输入已保留。`
              : `本次未发送：${String(e)}。输入已保留。`,
        );
    } finally {
      if (gen === generation.current) {
        mutationLock.current = false;
        setPending(false);
      }
    }
  };
  const mutate: Mutate = (command) => performMutation(command);
  const leaveDraft = () =>
    (!draft && !draftPanelInput) || confirm("存在本地图或草稿面板输入，切换可能丢弃未保存编辑。请先保存/复制。继续？");
  function selectVersion(id: string) {
    if (!leaveDraft()) return;
    setDraft(undefined);
    setRunId("");
    setVersionId(id);
    setNodeId("");
    setMemberId("");
    setSelectedEdge(undefined);
  }
  function selectRun(id: string) {
    if (!leaveDraft()) return;
    setDraft(undefined);
    setRunId(id);
    setNodeId("");
    setMemberId("");
    setSelectedEdge(undefined);
  }
  function updateVersion(fn: (v: WorkflowVersion) => WorkflowVersion) {
    if (version && !run) setDraft(fn(structuredClone(version)));
  }
  function updateNode(patch: Partial<WorkflowNode>) {
    updateVersion((v) => ({
      ...v,
      graph: {
        ...v.graph,
        nodes: v.graph.nodes.map((n) =>
          n.id === nodeId ? { ...n, ...patch } : n,
        ),
      },
    }));
  }
  function updateRole(id: string, patch: Partial<WorkflowRole>) {
    updateVersion((v) => ({
      ...v,
      roles: v.roles.map((r) => (r.id === id ? { ...r, ...patch } : r)),
    }));
  }
  const graphNodes =
    version?.graph.nodes.map((n, i) => {
      const a =
        snapshot && run ? currentAttempt(snapshot, run.id, n.id) : undefined;
      // Topological levels keep parallel AND branches visible without a layout service.
      const level = (id: string, seen = new Set<string>()): number => {
        if (seen.has(id)) return 0;
        const next = new Set(seen).add(id);
        const parents = version.graph.edges.filter(
          (e) => e.to === id && e.kind === "normal",
        );
        return parents.length
          ? 1 + Math.max(...parents.map((e) => level(e.from, next)))
          : 0;
      };
      const l = level(n.id);
      const peers = version.graph.nodes
        .slice(0, i)
        .filter((p) => level(p.id) === l).length;
      return {
        id: n.id,
        position: { x: l * 240, y: peers * 135 },
        selected: n.id === nodeId,
        className: `stage ${a?.status ?? n.kind}`,
        data: {
          label: (
            <>
              <strong>{n.name}</strong>
              <small>
                {n.kind} · {n.mode}
              </small>
              <small>
                {a ? `${label(a.status)} · 第 ${a.round} 轮` : n.id}
              </small>
            </>
          ),
        },
      };
    }) ?? [];
  const graphEdges =
    version?.graph.edges.map((e, i) => ({
      id: String(i),
      source: e.from,
      target: e.to,
      label: e.kind === "return" ? "返工" : "",
      animated: false,
      style: {
        stroke: e.kind === "return" ? "#d49748" : "#667e90",
        strokeDasharray: e.kind === "return" ? "5 5" : undefined,
      },
      markerEnd: { type: MarkerType.ArrowClosed },
      selected: selectedEdge === i,
    })) ?? [];
  const onConnect = (c: Connection) => {
    if (c.source && c.target && !run)
      updateVersion((v) => ({
        ...v,
        graph: {
          ...v.graph,
          edges: [
            ...v.graph.edges,
            { from: c.source!, to: c.target!, kind: edgeKind },
          ],
        },
      }));
  };
  if (!studio) return <>
    {(error || unresolved || connectionState.includes("失败") || connectionState.includes("断开")) && <div className="desk-notifications" role="alert">
      {error && <details open><summary>这次操作没有确认成功</summary><p>{error}</p><button onClick={()=>setError("")}>收起提示</button></details>}
      {unresolved && <><span>上次操作的结果还不确定。</span><button disabled={pending} onClick={()=>void performMutation(unresolved.command,true)}>核对上一次操作</button></>}
      {connectionState!=="已连接"&&<button onClick={()=>setReconnect(x=>x+1)}>重新连接项目</button>}
    </div>}
    {snapshot ? <TeamDesk s={snapshot} run={run} busy={pending||!!unresolved} active={active} connection={connection.current}
      choose={selectRun} mutate={mutate} design={id=>{selectVersion(id??published?.id??"");setStudioTab("discuss");setStudio(true)}} inspect={id=>{selectRun(id);setStudioTab("graph");setStudio(true)}}/>:<div className="studio-bar">正在打开工作台…</div>}
    </>;
  return (
    <div className="app design-studio" data-pane={studioTab}>
      <div className="studio-bar"><button onClick={()=>{if(leaveDraft())setStudio(false)}}>← 返回团队对话</button><b>{run?"流程和工作记录":"设计工作流程"}</b></div>

      <div className="messages" aria-live="polite">
        {error && (
          <div className="error" role="alert">
            {error}
            <button onClick={() => setError("")}>关闭</button>
          </div>
        )}
        {notice && (
          <div className="notice">
            {notice}
            <button onClick={() => setNotice("")}>关闭</button>
          </div>
        )}
        {pending && <div className="notice">正在请求后端，请勿重复提交…</div>}
        {unresolved && (
          <div className="notice" role="status">
            <strong>未决操作：不能作为新操作重复提交</strong>
            <p>
              requestId={unresolved.requestId} · {unresolved.command.type}
              <br />
              {unresolved.command.type === "run.start"
                ? `原 runId=${unresolved.command.payload.runId}`
                : unresolved.command.type === "template.import"
                  ? `原 version=${unresolved.command.payload.version.id}`
                  : ""}
              <br />
              scope={unresolved.scope.backendId} /{" "}
              {unresolved.scope.projectDirectory}
            </p>
            <button
              disabled={pending}
              onClick={() =>
                void connection.current
                  ?.refresh()
                  .then(() =>
                    setNotice(
                      "已重读后端。即使原 run/版本已可见，仍可按原身份重试取回结果；不能据不存在就认定未提交。",
                    ),
                  )
                  .catch((e) => setError(String(e)))
              }
            >
              核对权威状态（不提交）
            </button>
            <button
              disabled={pending}
              onClick={() => void performMutation(unresolved.command, true)}
            >
              按原 envelope / requestId 重试
            </button>
            <button
              disabled={pending}
              onClick={async () => {
                if (
                  !confirm(
                    `明确放弃跟踪 ${unresolved.requestId}？\n原操作可能已经提交，放弃不会取消它。修改需求/再次启动将是新操作，可能重复执行。请先核对原 run/版本。`,
                  )
                )
                  return;
                try {
                  await connection.current?.forgetMutation();
                  setNotice(
                    "已明确放弃原操作跟踪（没有取消后端操作）；后续提交会使用新身份。",
                  );
                } catch (e) {
                  setError(String(e));
                }
              }}
            >
              明确处理未决项后允许新操作
            </button>

          </div>
        )}
      </div>
      <div className="workspace">

        <main>
          {member && snapshot ? (
            <SessionView
              key={member.sessionId}
              member={member}
              active={active}
              snapshot={snapshot}
              connection={connection.current}
              mutate={mutate}
              mutationPending={pending || !!unresolved}
              back={() => setMemberId("")}
              open={setMemberId}
            />
          ) : (
            <>
              <div className="page-title">
                <div>
                  <span className="eyebrow">
                    {run ? "团队工作记录" : "流程设计室"}
                  </span>
                  <h1>
                    {run?.label ??
                      snapshot?.templates.find(
                        (t) => t.id === version?.templateId,
                      )?.name ??
                      "正在载入工作流…"}
                  </h1>
                  {!run&&snapshot&&<label>选择流程 <select value={published?.id} onChange={e=>selectVersion(e.target.value)}>{snapshot.versions.map((v,i)=><option value={v.id} key={v.id}>{snapshot.templates.find(t=>t.id===v.templateId)?.name} · {v.parentVersionId?"修订版":"初版"} ({i+1})</option>)}</select></label>}
                </div>
                {run && (
                  <span className={`status ${run.status}`}>
                    {label(run.status)}
                  </span>
                )}
              </div>
              <div className="studio-tabs" role="group" aria-label="流程工具"><button aria-pressed={studioTab==="discuss"} onClick={()=>setStudioTab("discuss")}>{run?"变更这次流程":"与设计者讨论"}</button><button aria-pressed={studioTab==="graph"} onClick={()=>setStudioTab("graph")}>查看流程图</button>{!run&&<button aria-pressed={studioTab==="start"} onClick={()=>setStudioTab("start")}>使用或导入流程</button>}</div><div hidden={studioTab!=="discuss"}>
              {snapshot && !run && <DraftView active={active} snapshot={snapshot} version={published} localVersion={draft}
                pending={pending || !!unresolved} mutate={mutate} connection={connection.current}
                touched={() => { editorEpoch.current++; setDraftPanelInput(true); }}
                input={draftPanelText} setInput={setDraftPanelText} editorEpoch={editorEpoch}
                preview={(v) => {
                  if (draft && pretty({ graph: draft.graph, roles: draft.roles }) !== pretty({ graph: v.graph, roles: v.roles }) &&
                    !confirm("图编辑器已有未保存的本地图/提示词输入。预览此面板草稿将替换它们（不会自动保存）。取消可完整保留当前图；请先采用到面板或复制备份。明确替换？")) return;
                  setDraft(v); setNodeId(""); setMemberId(""); setStudioTab("graph");
                }}
              />}
              {snapshot && run && <PatchView key={run.id} snapshot={snapshot} runId={run.id} pending={pending || !!unresolved} mutate={mutate} />}
              </div>
              {version && studioTab!=="discuss" && (
                <>
                  <div className="toolbar">
                    <span>
                      {version.graph.nodes.length} 节点 ·{" "}
                      {version.graph.edges.length} 连线 · {version.id}
                    </span>
                    {run ? (
                      <>
                        <button
                          disabled={
                            pending ||
                            !["running", "waiting"].includes(run.status)
                          }
                          onClick={() =>
                            void mutate({
                              type: "run.pause",
                              payload: { runId: run.id },
                            })
                          }
                        >
                          暂停调度
                        </button>
                        <button
                          disabled={pending || run.status !== "paused"}
                          onClick={() =>
                            void mutate({
                              type: "run.resume",
                              payload: { runId: run.id },
                            })
                          }
                        >
                          恢复调度
                        </button>
                        <button
                          className="danger"
                          disabled={
                            pending ||
                            ["completed", "cancelled"].includes(run.status)
                          }
                          onClick={() => {
                            if (
                              confirm(
                                "取消此实例并请求中断其执行？未核对安全前后端可能继续保留租约。",
                              )
                            )
                              void mutate({
                                type: "run.cancel",
                                payload: { runId: run.id },
                              });
                          }}
                        >
                          取消实例
                        </button>
                        <button onClick={() => selectVersion(version.id)}>
                          查看原始模板
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          onClick={() => {
                            setDraft(
                              (existing) =>
                                existing ?? structuredClone(version),
                            );
                          }}
                        >
                          建立本地草稿
                        </button>
                        {draft && (
                          <>
                            <span className="draft-badge">
                              本地未保存 · 仅此页面
                            </span>
                            <button
                              onClick={() => {
                                if (confirm("丢弃本地草稿？"))
                                  setDraft(undefined);
                              }}
                            >
                              丢弃草稿
                            </button>
                          </>
                        )}
                      </>
                    )}
                    <button
                      onClick={() =>
                        void connection.current
                          ?.refresh()
                          .catch((e) => setError(String(e)))
                      }
                    >
                      刷新后端
                    </button>
                  </div>
                  {run && (
                    <div className="run-summary">
                      <strong>{run.waitingReason ?? "无等待原因"}</strong>
                      <p>{run.brief}</p>
                      <small>
                        槽{" "}
                        {
                          snapshot?.tasks.filter(
                            (t) => t.runId === run.id && t.slotHeld,
                          ).length
                        }
                        /{run.config.activeSlots} · 子深度{" "}
                        {run.config.childDepth} · 返工预算{" "}
                        {run.config.reworkAttempts}
                      </small>
                    </div>
                  )}
                  <div className="graph" aria-label="工作流图">
                    <ReactFlow
                      key={`${runId}:${version.id}`}
                      nodes={graphNodes}
                      edges={graphEdges}
                      onNodeClick={(_, n) => setNodeId(n.id)}
                      onEdgeClick={(_, e) => setSelectedEdge(Number(e.id))}
                      onConnect={onConnect}
                      nodesDraggable={false}
                      nodesConnectable={!run}
                      fitView
                      fitViewOptions={{ padding: 0.15 }}
                      minZoom={0.25}
                      maxZoom={1.5}
                    >
                      <Background gap={24} />
                      <Controls />
                      <MiniMap />
                    </ReactFlow>
                  </div>
                  {!run && (
                    <div className="toolbar">
                      <small>
                        点击节点检查 /
                        编辑；拖动连接点增加边，点击边后删除。改动均为本地草稿。
                      </small>
                      <select
                        aria-label="新增连线类型"
                        value={edgeKind}
                        onChange={(e) =>
                          setEdgeKind(e.target.value as typeof edgeKind)
                        }
                      >
                        <option value="normal">正常依赖（AND）</option>
                        <option value="return">返工边</option>
                      </select>
                      <button
                        disabled={selectedEdge === undefined}
                        onClick={() => {
                          updateVersion((v) => ({
                            ...v,
                            graph: {
                              ...v.graph,
                              edges: v.graph.edges.filter(
                                (_, i) => i !== selectedEdge,
                              ),
                            },
                          }));
                          setSelectedEdge(undefined);
                        }}
                      >
                        删除选中连线
                      </button>
                      <button
                        onClick={() => {
                          const id = prompt("新节点 ID（唯一）");
                          if (id) {
                            updateVersion((v) => ({
                              ...v,
                              graph: {
                                ...v.graph,
                                nodes: [
                                  ...v.graph.nodes,
                                  {
                                    id,
                                    name: id,
                                    kind: "end",
                                    mode: "demo",
                                    prompt: "填写节点说明",
                                    inputs: [],
                                    deliverables: [],
                                    criteria: [],
                                    criteriaRevision: "1",
                                    writes: false,
                                  },
                                ],
                              },
                            }));
                            setNodeId(id);
                          }
                        }}
                      >
                        添加节点
                      </button>
                    </div>
                  )}
                  <div className="detail-layout">
                    <section className="panel">
                      {node ? (
                        <NodeEditor
                          key={`${runId}:${version.id}:${node.id}`}
                          node={node}
                          version={version}
                          readOnly={!!run}
                          update={updateNode}
                          updateRole={updateRole}
                          updateVersion={updateVersion}
                        />
                      ) : (
                        <div className="empty">
                          <h2>点击图中的节点</h2>
                          <p>
                            检查提示词、角色、产物与
                            Gate；运行中的配置只读，编辑请发布模板新版本。
                          </p>
                        </div>
                      )}
                    </section>
                    <section className="panel">
                      {run && snapshot ? (
                        <RunEvidence
                          key={`${runId}:${node?.id ?? "overview"}`}
                          snapshot={snapshot}
                          runId={run.id}
                          version={version}
                          node={node}
                          attempt={attempt}
                          mutate={mutate}
                          pending={pending}
                          openMember={setMemberId}
                        />
                      ) : (
                        <>
                          <h2>启动工作流</h2>
                          <p className="muted">
                            仅启动已发布版本。后端为本实例保留一条原生团队主会话；成员和子成员从实例进入私聊，不占原生默认列表。
                          </p>
                          <Field
                            title="实例名称"
                            value={runLabel}
                            onChange={setRunLabel}
                          />
                          <Field
                            title="任务说明"
                            value={brief}
                            onChange={setBrief}
                            multiline
                          />
                          <div className="numbers">
                            {[
                              ["执行槽", slots, setSlots, 1, 16],
                              ["子深度", depth, setDepth, 0, 2],
                              ["返工预算", reworks, setReworks, 0, 10],
                            ].map(([name, value, setter, min, max]) => (
                              <label key={String(name)}>
                                {String(name)}
                                <input
                                  type="number"
                                  min={Number(min)}
                                  max={Number(max)}
                                  value={Number(value)}
                                  onChange={(e) =>
                                    (setter as (n: number) => void)(
                                      Number(e.target.value),
                                    )
                                  }
                                />
                              </label>
                            ))}
                          </div>
                          <button
                            className="primary"
                            disabled={
                              pending ||
                              !!unresolved ||
                              !!draft ||
                              !runLabel.trim() ||
                              !brief.trim()
                            }
                            onClick={async () => {
                              const epoch = editorEpoch.current;
                              const id = `DEMO-web-${crypto.randomUUID()}`;
                              const result = await mutate({
                                type: "run.start",
                                payload: {
                                  runId: id,
                                  versionId: version.id,
                                  label: runLabel,
                                  brief,
                                  config: {
                                    activeSlots: slots,
                                    childDepth: depth,
                                    reworkAttempts: reworks,
                                  },
                                },
                              });
                              if (
                                result &&
                                 !result.inProgress &&
                                 !draftPanelInput &&
                                 epoch === editorEpoch.current
                              ) {
                                setRunId(id); setStudio(false);
                                setDraft(undefined);
                                setSelectedEdge(undefined);
                                setRunLabel("");
                                setBrief("");
                              }
                            }}
                          >
                            启动已发布版本
                          </button>
                          <p>本地修改请在“共享草稿 / 独立设计会话”采用并保存，经过独立设计后显式发布。</p>
                          <details>
                            <summary>从文件导入流程</summary>
                             <input aria-label="选择流程文件" type="file" accept="application/json,.json" onChange={async e=>{const f=e.target.files?.[0];if(!f)return;try{if(f.size>65536)throw new Error("文件超过 64 KB");setImportText(await f.text())}catch(e){setImportText("");setError(String(e))}}}/>
                            <button
                              disabled={pending || !!unresolved || !importText}
                              onClick={async () => {
                                try {
                                  const input = JSON.parse(importText);
                                  const template = TemplateSchema.parse(
                                      input.template,
                                    ),
                                    v = VersionSchema.parse(input.version);
                                  if (!confirm(`导入不可变版本 ${v.id}？`))
                                    return;
                                  const epoch = editorEpoch.current;
                                  const hadDraft = !!draft;
                                  const result = await mutate({
                                    type: "template.import",
                                    payload: { template, version: v },
                                  });
                                  if (result && !result.inProgress) {
                                    if (
                                      hadDraft ||
                                      epoch !== editorEpoch.current
                                    ) {
                                      setNotice(
                                        `版本 ${v.id} 已导入；当前本地草稿/输入与选择保留，不自动切换。`,
                                      );
                                    } else {
                                      setRunId("");
                                      setVersionId(v.id);
                                      setNodeId("");
                                      setSelectedEdge(undefined);
                                      setImportText("");
                                    }
                                  }
                                } catch (e) {
                                  setError(String(e));
                                }
                              }}
                            >
                              提交导入
                            </button>
                          </details>
                          <details>
                            <summary>导出流程文件</summary><button disabled={!published} onClick={()=>{if(!published)return;const template=snapshot?.templates.find(t=>t.id===published.templateId);if(!template)return;const url=URL.createObjectURL(new Blob([pretty({template,version:published})],{type:"application/json"}));const link=document.createElement("a");link.href=url;link.download="teamflow-template.json";link.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}}>下载已发布的版本</button>
                          </details>
                        </>
                      )}
                    </section>
                  </div>
                </>
              )}
            </>
          )}
        </main>
      </div>
      <footer>
        Teamflow · 工作流程设计
      </footer>
    </div>
  );
}

function RunEntry({ run, snapshot, connection, openMember }: {
  run: Run; snapshot: TeamflowSnapshot; connection?: TeamflowConnection; openMember(id: string): void;
}) {
  const [history, setHistory] = useState<unknown[]>();
  const [error, setError] = useState("");
  const entry = run.entry;
  const members = snapshot.members.filter(m => m.runId === run.id);
  return <section className="panel" aria-label="团队主入口">
    <h2>团队主入口</h2>
    <p>{run.brief}</p>
    {entry?.state === "ready" ? <>
      <p>{entry.source === "existing" ? "已绑定发起流程的原生聊天" : "原生 Sessions 中的 Teamflow 主会话"} · <code>{entry.sessionId}</code></p>
      <details>
        <summary>查看原生主会话</summary>
        <p>在同一项目的原生 TUI 中，使用 <code>/teamflow</code> → 查看实例与成员 → 打开原生团队主会话。后台派工不会自动唤醒主会话。</p>
        <button disabled={!connection} onClick={async () => {
          try { setHistory(await connection!.sessionMessages(entry.sessionId)); setError(""); }
          catch (cause) { setError(`无法读取原会话（不会重建）：${String(cause)}`); }
        }}>读取原生主会话历史</button>
        {error && <p role="alert">{error}</p>}
        {!error && history?.map((message, i) => <NativeMessage key={i} value={message} />)}
        {!error && history?.length === 0 && <p>尚无原生聊天消息。</p>}
      </details>
    </> : entry ? <p>主会话尚未就绪；后端只核对预留 ID，不会另建入口。{entry.error ? ` ${entry.error}` : ""}</p>
      : <p>历史实例没有原生主会话绑定；不自动迁移或创建。</p>}
    <h3>成员私聊</h3>
    {members.length ? members.map(m => <button key={m.id} onClick={() => openMember(m.id)}>
      {m.parentMemberId ? "子成员 · " : ""}{m.role} · {m.id}
    </button>) : <p className="muted">尚无可进入的成员会话。</p>}
    <p className="muted">议题和成员回执见下方「协作与纠偏」。暂停时可查阅历史，私聊意图等待恢复后投递。</p>
  </section>;
}

function NodeEditor({
  node,
  version,
  readOnly,
  update,
  updateRole,
  updateVersion,
}: {
  node: WorkflowNode;
  version: WorkflowVersion;
  readOnly: boolean;
  update: (p: Partial<WorkflowNode>) => void;
  updateRole: (id: string, p: Partial<WorkflowRole>) => void;
  updateVersion: (fn: (v: WorkflowVersion) => WorkflowVersion) => void;
}) {
  const role = version.roles.find((r) => r.id === node.role);
  const field = (
    title: string,
    value: string,
    fn: (v: string) => void,
    multiline = false,
  ) => (
    <Field
      title={title}
      value={value}
      onChange={readOnly ? undefined : fn}
      multiline={multiline}
    />
  );
  return (
    <>
      <div className="section-heading">
        <h2>节点 · {node.name}</h2>
        <span className="muted">
          {readOnly ? "运行配置只读" : "编辑产生本地未保存草稿"}
        </span>
      </div>
      <code>{node.id}</code>
      {field("名称", node.name, (name) => update({ name }))}
      <div className="numbers">
        <label>
          节点类型
          <select
            disabled={readOnly}
            value={node.kind}
            onChange={(e) =>
              update({
                kind: e.target.value as WorkflowNode["kind"],
                gate:
                  e.target.value === "gate"
                    ? { user: true, reviewRoles: [], testRoles: [] }
                    : undefined,
              })
            }
          >
            {["work", "review", "test", "gate", "end"].map((k) => (
              <option key={k}>{k}</option>
            ))}
          </select>
        </label>
        <label>
          模式
          <select
            disabled={readOnly}
            value={node.mode}
            onChange={(e) =>
              update({ mode: e.target.value as WorkflowNode["mode"] })
            }
          >
            {["demo", "analysis", "formal"].map((k) => (
              <option key={k}>{k}</option>
            ))}
          </select>
        </label>
      </div>
      {field("节点提示词", node.prompt, (prompt) => update({ prompt }), true)}
      <label className="field">
        角色
        <select
          disabled={readOnly}
          value={node.role ?? ""}
          onChange={(e) => update({ role: e.target.value || undefined })}
        >
          <option value="">无角色</option>
          {version.roles.map((r) => (
            <option key={r.id}>{r.id}</option>
          ))}
        </select>
      </label>
      <label className="check">
        <input
          type="checkbox"
          disabled={readOnly}
          checked={node.writes}
          onChange={(e) => update({ writes: e.target.checked })}
        />
        需要写权限 / 写租约
      </label>
      {(["inputs", "deliverables", "criteria"] as const).map((key, i) => (
        <React.Fragment key={key}>
          {field(
            ["输入（每行一项）", "交付物（每行一项）", "验收标准（每行一项）"][
              i
            ],
            node[key].join("\n"),
            (value) => update({ [key]: lines(value) }),
            true,
          )}
        </React.Fragment>
      ))}
      {field(
        "验收标准版本（与源 work / 检查 / Gate 一致）",
        node.criteriaRevision,
        (criteriaRevision) => update({ criteriaRevision }),
      )}
      {field("交付源节点 ID", node.sourceNodeId ?? "", (sourceNodeId) =>
        update({ sourceNodeId: sourceNodeId || undefined }),
      )}
      {node.gate && (
        <fieldset>
          <legend>Gate · 后端判断通过</legend>
          <label className="check">
            <input
              type="checkbox"
              disabled={readOnly}
              checked={node.gate.user}
              onChange={(e) =>
                update({ gate: { ...node.gate!, user: e.target.checked } })
              }
            />
            需要用户显式批准
          </label>
          {field(
            "必需 review 角色（每行一项）",
            node.gate.reviewRoles.join("\n"),
            (v) => update({ gate: { ...node.gate!, reviewRoles: lines(v) } }),
            true,
          )}
          {field(
            "必需 test 角色（每行一项）",
            node.gate.testRoles.join("\n"),
            (v) => update({ gate: { ...node.gate!, testRoles: lines(v) } }),
            true,
          )}
        </fieldset>
      )}
      {role && (
        <fieldset>
          <legend>角色配置 · {role.id}（使用此角色的节点共用）</legend>
          {(["agent", "responsibility", "prompt"] as const).map((key) => (
            <React.Fragment key={key}>
              {field(
                {
                  agent: "原生 Agent",
                  responsibility: "职责",
                  prompt: "角色提示词",
                }[key],
                role[key],
                (v) => updateRole(role.id, { [key]: v }),
                key !== "agent",
              )}
            </React.Fragment>
          ))}
          {field(
            "模型 providerID（留空使用后端默认）",
            role.model?.providerID ?? "",
            (v) =>
              updateRole(role.id, {
                model: v
                  ? { providerID: v, id: role.model?.id ?? "" }
                  : undefined,
              }),
          )}
          {field("模型 ID", role.model?.id ?? "", (v) =>
            updateRole(role.id, {
              model: { providerID: role.model?.providerID ?? "", id: v },
            }),
          )}
          {(["permissions", "skills", "childRoles"] as const).map((key, i) => (
            <React.Fragment key={key}>
              {field(
                [
                  "权限（每行一项）",
                  "Skill（每行一项）",
            "允许子角色（受角色/深度/调度槽限制）",
                ][i],
                role[key].join("\n"),
                (v) => updateRole(role.id, { [key]: lines(v) }),
                true,
              )}
            </React.Fragment>
          ))}
          <label className="field">
            最大子深度（0–2）
            <input
              disabled={readOnly}
              type="number"
              min={0}
              max={2}
              value={role.maxDepth}
              onChange={(e) =>
                updateRole(role.id, { maxDepth: Number(e.target.value) })
              }
            />
          </label>
        </fieldset>
      )}
      {!readOnly && (
        <>
          <fieldset>
            <legend>图约束</legend>
            {field("入口节点", version.graph.entry, (entry) =>
              updateVersion((v) => ({ ...v, graph: { ...v.graph, entry } })),
            )}
            {field(
              "必需 Gate ID（每行一项）",
              version.graph.requiredGateIds.join("\n"),
              (v) =>
                updateVersion((x) => ({
                  ...x,
                  graph: { ...x.graph, requiredGateIds: lines(v) },
                })),
              true,
            )}
          </fieldset>
          <button
            onClick={() => {
              const id = prompt("新角色 ID");
              if (id)
                updateVersion((v) => ({
                  ...v,
                  roles: [
                    ...v.roles,
                    {
                      id,
                      agent: "build",
                      responsibility: "填写职责",
                      prompt: "填写提示词",
                      permissions: [],
                      skills: [],
                      childRoles: [],
                      maxDepth: 0,
                    },
                  ],
                }));
            }}
          >
            添加角色
          </button>
          <button
            className="danger"
            onClick={() => {
              if (
                confirm(
                  `删除节点 ${node.id} 及其连线？请修正入口/源/Gate引用。`,
                )
              )
                updateVersion((v) => ({
                  ...v,
                  graph: {
                    ...v.graph,
                    nodes: v.graph.nodes.filter((n) => n.id !== node.id),
                    edges: v.graph.edges.filter(
                      (e) => e.from !== node.id && e.to !== node.id,
                    ),
                  },
                }));
            }}
          >
            删除节点
          </button>
        </>
      )}
    </>
  );
}

function RunEvidence({
  snapshot: s,
  runId,
  version,
  node,
  attempt,
  mutate,
  pending,
  openMember,
}: {
  snapshot: TeamflowSnapshot;
  runId: string;
  version: WorkflowVersion;
  node?: WorkflowNode;
  attempt?: StageAttempt;
  mutate: Mutate;
  pending: boolean;
  openMember: (id: string) => void;
}) {
  const [reason, setReason] = useState("");
  const sourceAttempt = node?.sourceNodeId
    ? currentAttempt(s, runId, node.sourceNodeId)
    : attempt;
  const delivery = s.deliveries
    .filter((d) => d.attemptId === sourceAttempt?.id)
    .at(-1);
  const tasks = s.tasks.filter(
    (t) => t.runId === runId && (!node || t.attemptId === attempt?.id),
  );
  const members = s.members.filter(
    (m) =>
      m.runId === runId && (!node || tasks.some((t) => t.memberId === m.id)),
  );
  const binding =
    attempt && delivery
      ? {
          attemptId: attempt.id,
          deliveryId: delivery.id,
          artifactRevision: delivery.artifactRevision,
          criteriaRevision: delivery.criteriaRevision,
        }
      : undefined;
  const approve = async (reject: boolean) => {
    if (!binding) return;
    if (
      !confirm(
        `${reject ? "打回返工" : "批准此 Gate"}？\n${delivery?.summary ?? ""}\n此操作仅代表你对此次交付的明确决定。`,
      )
    )
      return;
    const result = await mutate(
      reject
        ? { type: "gate.reject", payload: { ...binding, reason } }
        : { type: "gate.approve", payload: binding },
    );
    if (result && !result.inProgress) setReason("");
  };
  return (
    <>
      <h2>{node ? "执行 / 交付证据" : "实例概览"}</h2>
      {attempt && (
        <div className="run-summary">
          <span className={`status ${attempt.status}`}>
            {label(attempt.status)}
          </span>
          <p>
            第 {attempt.round} 轮 · {attempt.id}
          </p>
          <p>{attempt.reason}</p>
          <small>criteriaRevision: {attempt.criteriaRevision}</small>
        </div>
      )}
      {!node &&
        s.attempts
          .filter(
            (a) =>
              a.runId === runId &&
              currentAttempt(s, runId, a.nodeId)?.id === a.id,
          )
          .map((a) => (
            <p key={a.id}>
              <b>{a.nodeId}</b> · {label(a.status)} · 第{a.round}轮 {a.reason}
            </p>
          ))}
      {delivery ? (
        <article>
          <h3>当前源交付</h3>
          <p>{delivery.summary}</p>
          <dl>
            <dt>delivery / source attempt</dt>
            <dd>
              {delivery.id}
              <br />
              {delivery.attemptId}
            </dd>
            <dt>artifact / criteria</dt>
            <dd>
              {delivery.artifactRevision} / {delivery.criteriaRevision}
            </dd>
            <dt>产物</dt>
            <dd>{delivery.artifacts.join("\n")}</dd>
            <dt>未解决问题</dt>
            <dd>{delivery.unresolved.join("\n") || "无申报问题"}</dd>
          </dl>
          {delivery.checks.map((c, i) => (
            <details key={i} open>
              <summary>
                {c.source} · exit {c.exitCode} · {c.command}
              </summary>
              <p>版本 {c.version}</p>
              <pre>{c.output}</pre>
            </details>
          ))}
        </article>
      ) : (
        <p className="muted">当前尝试尚无交付；无交付不代表通过。</p>
      )}
      {node?.kind === "gate" && (
        <fieldset>
          <legend>用户决定</legend>
          <p>仅当前 Gate 与源节点最高轮交付。后端仍核对专业检查及版本。</p>

          <Field
            title="打回原因"
            value={reason}
            onChange={setReason}
            multiline
          />
          <button
            className="primary"
            disabled={
              pending ||
              !binding ||
              !node.gate?.user ||
              attempt?.status !== "awaiting_gate"
            }
            onClick={() => void approve(false)}
          >
            明确批准此交付
          </button>
          <button
            className="danger"
            disabled={
              pending ||
              !binding ||
              !reason.trim() ||
              !attempt ||
              ["passed", "superseded", "cancelled"].includes(attempt.status)
            }
            onClick={() => void approve(true)}
          >
            打回并要求返工
          </button>
        </fieldset>
      )}
      <h3>批准记录（含失效记录）</h3>
      {s.approvals
        .filter(
          (a) =>
            a.runId === runId &&
            (!node ||
              a.attemptId === attempt?.id ||
              a.targetAttemptId === sourceAttempt?.id),
        )
        .map((a) => (
          <details key={a.id}>
            <summary>
              {a.kind} · {a.verdict} · {a.valid ? "后端有效" : "已失效"}
            </summary>
            <p>{a.issues.join("；") || "没有附加意见"}</p>
          </details>
        ))}
      <h3>成员 / 原始会话</h3>
      {members.map((m) => (
        <button className="member" key={m.id} onClick={() => openMember(m.id)}>
          <strong>{m.role}</strong>
          <small>
            {m.id}
            <br />
            {m.sessionId}
          </small>
          打开会话 →
        </button>
      ))}
      <h3>派工与租约</h3>
      {tasks.map((t) => (
        <TaskControl key={t.id} task={t} mutate={mutate} pending={pending} />
      ))}
      <details><summary>往轮交付</summary>{s.deliveries.filter(d=>d.runId===runId).map(d=><article key={d.id}><b>{d.staleBy?"历史版本":"已交付"}</b><p>{d.summary}</p></article>)}</details>
      <CollaborationPanel snapshot={s} runId={runId} mutate={mutate} pending={pending} />

    </>
  );
}
function TaskControl({
  task: t,
  mutate,
  pending,
}: {
  task: Task;
  mutate: Mutate;
  pending: boolean;
}) {
  const [reason, setReason] = useState(""),
    [sessionId, setSessionId] = useState("");
  async function reconcile(action: "inspect" | "bind" | "terminate") {
    if (
      action !== "inspect" &&
      !confirm(
        `请求后端${action === "bind" ? "绑定已有真实执行（不重发）" : "停止并安全终止此派工"}？\n${t.id}\n原因：${reason}\nblocked/进行中不代表解锁。`,
      )
    )
      return;
    await mutate({
      type: "dispatch.reconcile",
      payload: {
        taskId: t.id,
        action,
        reason,
        ...(sessionId ? { sessionId } : {}),
      },
    });
  }
  return (
    <article>
      <h4>{t.id}</h4>
      <p>
        {label(t.status)} ·{" "}
        {t.slotHeld ? "占用执行槽 / 可能持写租约" : "未占槽"} ·{" "}
        {t.writes ? "写任务" : "只读任务"}
      </p>
      {t.error && <p className="error">{t.error}</p>}
      <details open={t.status === "uncertain"}>
        <summary>派工阶段、核对结果与证据</summary>
        <p>{t.inspection?.evidence.join("；") ?? t.reconciliation?.evidence.join("；") ?? "尚未进行人工核对。"}</p>
      </details>
      {(t.status === "uncertain" ||
        t.slotHeld ||
        t.inspection ||
        t.reconciliation) && (
        <>
          <Field
            title="核对理由（必填，失败保留）"
            value={reason}
            onChange={setReason}
          />
          <Field
            title="待核对 sessionId（可选，不改变已绑定 ID）"
            value={sessionId}
            onChange={setSessionId}
          />
          <button
            disabled={pending || !reason.trim()}
            onClick={() => void reconcile("inspect")}
          >
            重新核对（新 requestId）
          </button>
          <button
            disabled={pending || !reason.trim() || t.status !== "uncertain"}
            onClick={() => void reconcile("bind")}
          >
            请求绑定已有执行
          </button>
          <button
            className="danger"
            disabled={pending || !reason.trim()}
            onClick={() => void reconcile("terminate")}
          >
            请求安全终止
          </button>
        </>
      )}
    </article>
  );
}

function SessionView({
  member,
  active,
  snapshot,
  connection,
  mutate,
  mutationPending,
  back,
  open,
}: {
  member: Member;
  active: boolean;
  snapshot: TeamflowSnapshot;
  connection?: TeamflowConnection;
  mutate: Mutate;
  mutationPending: boolean;
  back: () => void;
  open: (id: string) => void;
}) {
  const [messages, setMessages] = useState<unknown[]>([]),
    [text, setText] = useState(""),
    [error, setError] = useState(""),
    [sendError, setSendError] = useState(""),
    [notice, setNotice] = useState(""),
    [pending, setPending] = useState(false),
    [loading, setLoading] = useState(true);
  const [topicId, setTopicId] = useState(""), [unrelatedReason, setUnrelatedReason] = useState("");
  const sequence = useRef(0);
  const sendGeneration = useRef(0);
  const alive = useRef(true);
  const task = snapshot.tasks.find((t) => t.sessionId === member.sessionId);
  const canSend =
    !member.legacy && !!task && ["running", "submitted"].includes(task.status) && !task.child?.staleBy &&
    !["cancelled", "failed"].includes(snapshot.runs.find(r => r.id === member.runId)?.status ?? "failed");
  async function load() {
    const seq = ++sequence.current;
    try {
      if (!connection) throw new Error("连接尚未就绪");
      const result = await connection.sessionMessages(member.sessionId);
      if (alive.current && seq === sequence.current) {
        setMessages(result);
        setError("");
        setLoading(false);
      }
    } catch (e) {
      if (alive.current && seq === sequence.current) {
        setError(
          `读取原生会话失败：${String(e)}。成员和 session ID 保留，可刷新重试；不自动创建替代会话。`,
        );
        setLoading(false);
      }
    }
  }
  useEffect(() => {
    sendGeneration.current++;
    setPending(false);
    if (!active) {
      setMessages([]);
      setLoading(true);
      setError("");
      return;
    }
    alive.current = true;
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => {
      alive.current = false;
      sendGeneration.current++;
      sequence.current++;
      clearInterval(timer);
    };
  }, [connection, member.sessionId, active]);
  async function send() {
    if (!connection || !active || pending || mutationPending) return;
    const generation = sendGeneration.current;
    const currentSend = () => alive.current && generation === sendGeneration.current;
    setPending(true);
    setSendError("");
    setNotice("");
    const sentText = text;
    try {
      const result = await mutate({ type: "message.send", payload: { runId: member.runId, toMemberId: member.id, text: sentText, ...(topicId ? { topicId } : unrelatedReason ? { unrelatedReason } : {}) } });
      if (!result) return;
      if (currentSend()) {
        setNotice("消息意图已持久化；原生接收与成员处理确认分开追踪。输入保留，不自动重发。");
        await load();
      }
    } catch (e) {
      if (currentSend()) setSendError(`${String(e)}；消息输入已保留。`);
    } finally {
      if (currentSend()) setPending(false);
    }
  }
  return (
    <>
      <button onClick={back}>← 返回流程</button>
      <div className="page-title">
        <div>
          <span className="eyebrow">成员 / 原生 OpenCode 会话</span>
          <h1>{member.role}</h1>
          <code>{member.sessionId}</code>
          <p>
            {member.id} · run {member.runId}
          </p>
        </div>
        <button onClick={() => void load()}>刷新消息与工具状态</button>
      </div>
      <p className="muted">
        原始 session ID
        保持不变。消息来自原生上下文；没有完整响应前不推断成员空闲或完成。
      </p>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {sendError && (
        <div className="error" role="alert">
          {sendError}
        </div>
      )}
      {notice && <div className="notice">{notice}</div>}
      <div className="panel session-messages">
        {loading
          ? "读取原生会话…"
          : messages.length === 0
            ? error
              ? "读取失败，尚未取得原生消息。"
              : "原生上下文暂无消息"
            : messages.map((message, i) => (
                <NativeMessage key={i} value={message} />
              ))}
      </div>
      <section className="panel">
        <h2>向此成员发送指示</h2>
        <p>
          {canSend
             ? snapshot.runs.find(r => r.id === member.runId)?.status === "paused"
               ? "调度已暂停：此处只登记消息意图，恢复后才可投递到原会话。"
               : "同一原生会话继续；调度器获取槽位/写租约后恢复，不重交旧工作/通过结论；原专业成员可对仍有效的同一交付登记迟到负面结论。"
             : "已取消 / 被替换 / 不确定 / 过期会话只读，不复活旧工作。"}
        </p>
        <Field
          title="消息（失败保留，最多 32000 字符）"
          value={text}
          onChange={setText}
          multiline
        />
        <label className="field">消息关联议题<select value={topicId} onChange={e => setTopicId(e.target.value)}><option value="">无关联（歧义时须填写无关原因）</option>{snapshot.topics.filter(t => t.runId === member.runId).map(t => <option key={t.id} value={t.id}>{t.id} · {t.status}</option>)}</select></label>
        <Field title="与已有议题无关的明确原因" value={unrelatedReason} onChange={setUnrelatedReason} />
        <button
          className="primary"
            disabled={!canSend || pending || mutationPending || !text.trim() || text.length > 32000}
          onClick={() => void send()}
        >
          {pending ? "正在发送…" : "发送到原始会话"}
        </button>
        <h3>子成员</h3>
        {snapshot.members
          .filter((m) => m.parentMemberId === member.id)
          .map((m) => (
            <button key={m.id} onClick={() => open(m.id)}>
              {m.role} · {m.sessionId}
            </button>
          ))}
        <p className="muted">子成员由真实成员工具登记创建；消息、议题及纠偏跟踪见流程中的协作面板。</p>
      </section>
    </>
  );
}
function NativeMessage({ value }: { value: unknown }) {
  if (!value || typeof value !== "object") return null;
  const record=value as Record<string,any>;const role=record.info?.role??record.role;
  if(role!=="assistant"&&role!=="user")return null;
  const parts=record.parts??record.content??[];
  const text=(Array.isArray(parts)?parts:[]).filter(p=>p.type==="text"&&!p.synthetic&&typeof p.text==="string").map(p=>p.text).join("\n")||record.text;
  if(typeof text!=="string"||!text.trim()||text.startsWith("[Teamflow source:"))return null;
  return <article className="native-message"><b>{role==="assistant"?"成员回复":"我"}</b><p>{text}</p></article>;
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BackendChooser workspace={(scope, active) => <App selectedScope={scope} active={active} />} />
  </React.StrictMode>,
);
