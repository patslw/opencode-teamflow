import { useMemo } from "react";
import { Background, BaseEdge, Controls, Handle, MarkerType, Position, ReactFlow } from "@xyflow/react";
import type { Edge, EdgeProps, Node, NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "./stage-graph.css";
import type { Run, TeamflowSnapshot, WorkflowVersion } from "../../../packages/protocol/src/index";

type Props = {
  version: WorkflowVersion;
  run?: Run;
  snapshot?: TeamflowSnapshot;
  selectedId?: string;
  onSelect?: (id: string) => void;
  onConnect?: (source: string, target: string) => void;
  onEdgeSelect?: (i: number) => void;
  selectedEdge?: number;
};

type StageData = { name: string; kind: string; status: string; detail: string; editable: boolean };
type StageNode = Node<StageData, "stage">;
type RouteData = { lane: number; sourceGutter: number; targetGutter: number; isReturn: boolean; adjacent:boolean };
type RouteEdge = Edge<RouteData, "route">;

const kinds: Record<string, string> = { work: "执行", review: "评审", test: "测试", gate: "审批", end: "结束" };
const statuses: Record<string, string> = {
  pending: "待前置完成", ready: "就绪", running: "进行中", awaiting_gate: "等待批准",
  passed: "已通过", needs_revision: "需要返工", failed: "失败", cancelled: "已取消", superseded: "已失效",
};

function StageNodeView({ data }: NodeProps<StageNode>) {
  return <div className={`sg-card sg-status-${data.status}`}>
    <Handle type="target" position={Position.Left} isConnectable={data.editable} />
    <div className="sg-card-top"><span className="sg-kind">{kinds[data.kind] ?? data.kind}</span><span className="sg-status">{statuses[data.status] ?? data.status}</span></div>
    <strong className="sg-name">{data.name}</strong>
    <span className="sg-detail">{data.detail}</span>
    <Handle type="source" position={Position.Right} isConnectable={data.editable} />
  </div>;
}

function RouteEdgeView({ id, sourceX, sourceY, targetX, targetY, data, markerEnd, selected }: EdgeProps<RouteEdge>) {
  if (!data) return null;
  const path = data.adjacent?`M ${sourceX} ${sourceY} C ${(sourceX+targetX)/2} ${sourceY} ${(sourceX+targetX)/2} ${targetY} ${targetX} ${targetY}`:`M ${sourceX} ${sourceY} L ${data.sourceGutter} ${sourceY} L ${data.sourceGutter} ${data.lane} L ${data.targetGutter} ${data.lane} L ${data.targetGutter} ${targetY} L ${targetX} ${targetY}`;
  return <BaseEdge id={id} path={path} markerEnd={markerEnd} interactionWidth={20} className={`sg-edge ${data.isReturn ? "sg-edge-return" : "sg-edge-normal"} ${selected ? "sg-edge-selected" : ""}`} />;
}
const nodeTypes = { stage: StageNodeView };
const edgeTypes = { route: RouteEdgeView };
const WIDTH = 200;
const HEIGHT = 100;
const ROW = 145;

export function StageGraph({ version, run, snapshot, selectedId, onSelect, onConnect, onEdgeSelect, selectedEdge }: Props) {
  const { nodes, edges } = useMemo(() => {
    const graph = version.graph;
    const ids = new Set(graph.nodes.map(n => n.id));
    const incoming = new Map(graph.nodes.map(n => [n.id, 0]));
    const levels = new Map(graph.nodes.map(n => [n.id, 0]));
    const normal = graph.edges.filter(e => e.kind === "normal" && ids.has(e.from) && ids.has(e.to));
    for (const e of normal) incoming.set(e.to, (incoming.get(e.to) ?? 0) + 1);
    const queue = graph.nodes.filter(n => incoming.get(n.id) === 0).map(n => n.id);
    for (let i = 0; i < queue.length; i++) {
      const source = queue[i];
      for (const e of normal.filter(edge => edge.from === source)) {
        levels.set(e.to, Math.max(levels.get(e.to) ?? 0, (levels.get(source) ?? 0) + 1));
        incoming.set(e.to, (incoming.get(e.to) ?? 0) - 1);
        if (incoming.get(e.to) === 0) queue.push(e.to);
      }
    }
    // Invalid cyclic drafts remain visible, rather than recursing indefinitely.
    const gap = 78;
    const rows = new Map<number, number>();
    const positions = new Map<string, { x: number; y: number }>();
    const resultNodes: StageNode[] = graph.nodes.map(n => {
      const level = levels.get(n.id) ?? 0;
      const row = rows.get(level) ?? 0;
      rows.set(level, row + 1);
      const position = { x: level * (WIDTH + gap), y: row * ROW };
      positions.set(n.id, position);
      const attempt = run && snapshot ? snapshot.attempts.filter(a => a.runId === run.id && a.nodeId === n.id).reduce<(typeof snapshot.attempts)[number] | undefined>((latest, a) => !latest || a.round > latest.round ? a : latest, undefined) : undefined;
      return { id: n.id, type: "stage", position, selected: n.id === selectedId, data: { name: n.name, kind: n.kind, status: attempt?.status ?? (run ? "pending" : "未运行"), detail: attempt ? `第 ${attempt.round} 轮 · ${n.role ?? n.id}` : n.role ?? n.id, editable: !!onConnect } };
    });
    const bottom = Math.max(0, ...resultNodes.map(n => n.position.y + HEIGHT));
    const resultEdges: RouteEdge[] = graph.edges.flatMap((e, i) => {
      const source = positions.get(e.from), target = positions.get(e.to);
      if (!source || !target) return [];
      const offset = 18 + (i % 5) * 6;
      const isReturn = e.kind === "return";
      return [{ id: String(i), source: e.from, target: e.to, type: "route", selected: selectedEdge === i,
        markerEnd: { type: MarkerType.ArrowClosed, color: isReturn ? "#b45309" : "#51677b" },
        data: { isReturn, adjacent:!isReturn && target.x-source.x===WIDTH+gap, lane: isReturn ? bottom + 18+i*10 : -18-i*8, sourceGutter: source.x + WIDTH + offset, targetGutter: target.x - offset } }];
    });
    return { nodes: resultNodes, edges: resultEdges };
  }, [version, run, snapshot, selectedId, selectedEdge, onConnect]);

  return <section className="stage-graph" aria-label="工作流进度图">
    <div className="sg-legend"><span><i className="sg-legend-line" />正常流转</span><span><i className="sg-legend-line sg-legend-return" />返工</span><span className="sg-hint">{onConnect ? "拖动节点右侧连接点到左侧以连线 · 点击连线选择" : "点击节点查看详情"} · 拖动画布或使用缩放控件</span></div>
    <div className="sg-scroll" tabIndex={0} aria-label="流程画布，可横向滚动"><div className="sg-canvas" style={{minWidth:Math.min(4400,Math.max(...nodes.map(n=>n.position.x),0)*.75+220)}}><ReactFlow key={`${version.id}:${nodes.length}`} nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
      onNodeClick={(_, node) => onSelect?.(node.id)} onEdgeClick={(_, edge) => onEdgeSelect?.(Number(edge.id))}
      onConnect={connection => { if (connection.source && connection.target) onConnect?.(connection.source, connection.target); }}
      nodesDraggable={false} nodesConnectable={!!onConnect} elementsSelectable fitView fitViewOptions={{ padding: 0.08,maxZoom:1 }} minZoom={0.2} maxZoom={1.8}>
      <Background gap={24} color="#dce5eb" /><Controls showInteractive={false} />
    </ReactFlow></div></div>
  </section>;
}
