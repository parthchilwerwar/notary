// The five-stage graph (Read → Test → Challenge → Certify → Enforce) on @xyflow/react.
// Fixed layout at zoom 1 — no dragging, panning or zooming: horizontal when there is room,
// a vertical stack on narrow screens. Each node is a button that filters the event feed.
import { useMemo, useRef } from "react";
import {
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/base.css";
import { motion } from "motion/react";
import type { TimelineStage } from "../../../../core/src/schema";
import {
  STAGE_EDGES,
  STAGE_LABEL,
  STAGE_NOTE,
  STAGES,
  failureLine,
  stageLines,
  type NodeState,
  type StageStats,
} from "./model";
import { useElementWidth } from "./hooks";

type StageNodeData = {
  stage: TimelineStage;
  step: number;
  stats: StageStats;
  state: NodeState;
  selected: boolean;
  vertical: boolean;
  reduced: boolean;
};
type StageNodeType = Node<StageNodeData, "stage">;

export const STATE_LABEL: Record<NodeState, string> = {
  idle: "Idle",
  active: "Active",
  done: "Done",
  failed: "Failed",
};

function StageNode({ data }: NodeProps<StageNodeType>) {
  const { stage, stats, state, selected, vertical, step, reduced } = data;
  // Pulse once when the state changes (not on first render).
  const previous = useRef(state);
  const changes = useRef(0);
  if (previous.current !== state) {
    previous.current = state;
    changes.current++;
  }
  const lines = stageLines(stats);
  const failure = failureLine(stats);
  const label = STAGE_LABEL[stage];
  return (
    <>
      <Handle
        type="target"
        position={vertical ? Position.Top : Position.Left}
        isConnectable={false}
        className="stage-handle"
      />
      <button
        type="button"
        className="stage-node"
        data-state={state}
        data-selected={selected || undefined}
        aria-pressed={selected}
        aria-label={`${label}: ${stats.count} ${stats.count === 1 ? "event" : "events"}, ${STATE_LABEL[state].toLowerCase()}${failure ? ` (${failure})` : ""}. ${selected ? "Showing only this stage; press to show all." : "Press to filter the feed to this stage."}`}
      >
        {changes.current > 0 && !reduced && (
          <motion.span
            key={changes.current}
            className="stage-pulse"
            aria-hidden="true"
            initial={{ opacity: 0.7, scale: 0.98 }}
            animate={{ opacity: 0, scale: 1.04 }}
            transition={{ duration: 0.9, ease: "easeOut" }}
          />
        )}
        <span className="stage-head">
          <span className="stage-name">
            <span className="stage-step">{step}</span>
            {label}
          </span>
          <span className="stage-state" data-state={state}>
            <span className="stage-state-dot" aria-hidden="true" />
            {STATE_LABEL[state]}
          </span>
        </span>
        <span className="stage-figure">
          <motion.span
            key={stats.count}
            className="stage-count"
            initial={reduced || stats.count === 0 ? false : { opacity: 0.35, y: -3 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.25 }}
          >
            {stats.count}
          </motion.span>
          <span className="stage-unit">{stats.count === 1 ? "event" : "events"}</span>
        </span>
        <span className="stage-lines">
          {failure ? (
            <span className="stage-failure">{failure}</span>
          ) : lines.length ? (
            lines.slice(0, 2).join(" · ")
          ) : (
            STAGE_NOTE[stage]
          )}
        </span>
      </button>
      <Handle
        type="source"
        position={vertical ? Position.Bottom : Position.Right}
        isConnectable={false}
        className="stage-handle"
      />
    </>
  );
}

const nodeTypes = { stage: StageNode };

/** Pixel layout at zoom 1. Horizontal from 720px of graph width, else a vertical stack. */
export function stageLayout(width: number) {
  const vertical = width < 720;
  if (vertical) {
    const nodeW = Math.max(0, width);
    const nodeH = 92;
    const gap = 20;
    return {
      vertical,
      nodeW,
      nodeH,
      height: STAGES.length * nodeH + (STAGES.length - 1) * gap,
      position: (i: number) => ({ x: 0, y: i * (nodeH + gap) }),
    };
  }
  const gap = 32;
  const nodeW = (width - gap * (STAGES.length - 1)) / STAGES.length;
  const nodeH = 156;
  return {
    vertical,
    nodeW,
    nodeH,
    height: nodeH,
    position: (i: number) => ({ x: i * (nodeW + gap), y: 0 }),
  };
}

export function StageGraph({
  stats,
  states,
  selected,
  onSelect,
  lit,
  reduced,
}: {
  stats: Record<TimelineStage, StageStats>;
  states: Record<TimelineStage, NodeState>;
  selected: TimelineStage | null;
  onSelect: (stage: TimelineStage) => void;
  /** Edge ids carrying a hand-off right now. */
  lit: readonly string[];
  reduced: boolean;
}) {
  const [ref, width] = useElementWidth<HTMLDivElement>();
  const layout = stageLayout(width);

  const nodes = useMemo<StageNodeType[]>(
    () =>
      STAGES.map((stage, i) => ({
        id: stage,
        type: "stage",
        position: layout.position(i),
        width: layout.nodeW,
        height: layout.nodeH,
        style: { width: layout.nodeW, height: layout.nodeH },
        draggable: false,
        selectable: false,
        connectable: false,
        data: {
          stage,
          step: i + 1,
          stats: stats[stage],
          state: states[stage],
          selected: selected === stage,
          vertical: layout.vertical,
          reduced,
        },
      })),
    // layout is derived from width
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [width, stats, states, selected, reduced],
  );

  const litSet = new Set(lit);
  const edges: Edge[] = STAGE_EDGES.map((e) => {
    const on = litSet.has(e.id);
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      type: "straight",
      animated: on && !reduced,
      selectable: false,
      focusable: false,
      className: on ? "stage-edge lit" : "stage-edge",
      markerEnd: {
        type: MarkerType.ArrowClosed,
        width: 14,
        height: 14,
        color: on ? "var(--blue)" : "var(--edge)",
      },
    };
  });

  // Remount on an orientation switch so the viewport stays pinned at the origin.
  const key = layout.vertical ? "v" : "h";

  return (
    <div
      ref={ref}
      className="stage-graph"
      data-vertical={layout.vertical || undefined}
      style={{ height: width ? layout.height + 2 : undefined }}
    >
      {width > 0 && (
        <ReactFlow
          key={key}
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          defaultViewport={{ x: 0, y: 0, zoom: 1 }}
          minZoom={1}
          maxZoom={1}
          panOnDrag={false}
          panOnScroll={false}
          zoomOnScroll={false}
          zoomOnPinch={false}
          zoomOnDoubleClick={false}
          preventScrolling={false}
          nodesDraggable={false}
          nodesConnectable={false}
          nodesFocusable={false}
          edgesFocusable={false}
          elementsSelectable={false}
          autoPanOnNodeFocus={false}
          // The node's <button> has no handler of its own: its click (mouse, Enter or Space)
          // bubbles here. xyflow also only gives nodes pointer events when a handler exists.
          onNodeClick={(_, node) => onSelect(node.id as TimelineStage)}
          proOptions={{ hideAttribution: true }}
          aria-label="Stage graph: Read, Test, Challenge, Certify, Enforce"
        />
      )}
    </div>
  );
}
