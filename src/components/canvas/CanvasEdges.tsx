"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { NODE_TYPES, PORT_COLORS, type Graph, type GraphNode } from "@/lib/canvas/types";
import { NODE_WIDTH, NODE_HEADER_HEIGHT, NODE_PORT_SPACING } from "./CanvasNode";

type EdgePos = { x1: number; y1: number; x2: number; y2: number; color: string; id: string };

// ─────────────────────────────────────────────────────────────────────────────
// Fallback formula — used while DOM is still mounting, or when a port element
// can't be found (e.g. during initial render of a fresh edge).
//
// Port container is at `top: y`, where y = NODE_HEADER_HEIGHT + 14 + idx * SPACING.
// The 14px circle sits inside the container at top=0, so its visual centre is
// y + 7 (PORT_RADIUS).
//
// X for an INPUT port: the container is positioned at `left: -7`, the 14px
// circle therefore spans x ∈ [-7, +7] relative to the node's left edge, so
// centre = node.left + 0 (i.e. node.position.x).
//
// X for an OUTPUT port: container at `right: -7`, circle spans [node.right - 7,
// node.right + 7], centre = node.right (i.e. node.position.x + NODE_WIDTH).
// ─────────────────────────────────────────────────────────────────────────────
const PORT_RADIUS = 7;
const PORT_BASE_Y = NODE_HEADER_HEIGHT + 14 + PORT_RADIUS;

function fallbackPortY(node: GraphNode, portName: string, side: "in" | "out"): number {
  const def = NODE_TYPES[node.type];
  if (!def) return PORT_BASE_Y;
  const list = side === "in" ? def.inputs : def.outputs;
  const idx = list.findIndex((p) => p.name === portName);
  return PORT_BASE_Y + (idx < 0 ? 0 : idx) * NODE_PORT_SPACING;
}

export default function CanvasEdges({
  graph,
  hoveredEdgeId,
  draftEdge,
  liveDragNodeId,
  liveDragPos,
  pan,
  zoom,
  onHover,
  onDelete,
}: {
  graph: Graph;
  hoveredEdgeId: string | null;
  draftEdge: { x1: number; y1: number; x2: number; y2: number; color: string } | null;
  liveDragNodeId?: string | null;
  liveDragPos?: { x: number; y: number } | null;
  pan?: { x: number; y: number };
  zoom?: number;
  onHover: (id: string | null) => void;
  onDelete: (id: string) => void;
}) {
  // Cache of measured port centres in canvas-space coords, keyed by
  // `${nodeId}::${portName}::${side}`. Filled by useLayoutEffect — guarantees
  // pixel-perfect alignment regardless of CSS quirks (borders, antialiasing,
  // box-sizing differences across browsers).
  const [measured, setMeasured] = useState<Map<string, { x: number; y: number }>>(new Map());
  const svgRef = useRef<SVGSVGElement>(null);

  useLayoutEffect(() => {
    if (!svgRef.current) return;
    const svgRect = svgRef.current.getBoundingClientRect();
    const z = zoom ?? 1;
    const next = new Map<string, { x: number; y: number }>();

    // Find every port element in the document and record its centre in
    // canvas-local coords. We deliberately ignore pan/zoom by subtracting
    // the SVG's own rect — the SVG lives inside the same transform parent
    // as the nodes, so its rect reflects all transforms applied.
    const portEls = document.querySelectorAll<HTMLElement>("[data-port-side]");
    portEls.forEach((el) => {
      const nodeEl = el.closest<HTMLElement>("[data-node-id]");
      if (!nodeEl) return;
      const nodeId = nodeEl.getAttribute("data-node-id");
      const portId = el.getAttribute("data-port-id");
      const side = el.getAttribute("data-port-side") as "in" | "out" | null;
      if (!nodeId || !portId || !side) return;
      const rect = el.getBoundingClientRect();
      // Centre of the port in canvas-local (pre-transform) coords:
      const cx = (rect.left + rect.width / 2 - svgRect.left) / z;
      const cy = (rect.top + rect.height / 2 - svgRect.top) / z;
      next.set(`${nodeId}::${portId}::${side}`, { x: cx, y: cy });
    });

    setMeasured(next);
    // Re-measure whenever any node mutates (add, delete, drag-end commits a
    // new position, etc) or transforms change. We deliberately exclude
    // liveDragPos / draftEdge from deps — they change every frame and would
    // re-measure too often. During drag the formula fallback is used for the
    // dragged node, then a single remeasure happens once the position is
    // committed to graph.nodes on pointer up.
  }, [graph.nodes, graph.edges, pan?.x, pan?.y, zoom]);

  // Helper: position of a node (possibly overridden by live drag).
  function posOf(n: GraphNode): { x: number; y: number } {
    if (liveDragNodeId && liveDragPos && n.id === liveDragNodeId) return liveDragPos;
    return n.position;
  }

  // Helper: port centre — measured first, formula fallback.
  function portCentre(node: GraphNode, portName: string, side: "in" | "out"): { x: number; y: number } {
    const key = `${node.id}::${portName}::${side}`;
    const m = measured.get(key);
    if (m && !(liveDragNodeId === node.id)) {
      // Use measured value for stationary nodes — pixel-perfect.
      return m;
    }
    // Fallback for dragging or unmeasured ports: formula.
    const p = posOf(node);
    const y = p.y + fallbackPortY(node, portName, side);
    const x = side === "out" ? p.x + NODE_WIDTH : p.x;
    return { x, y };
  }

  const positions: EdgePos[] = [];
  for (const e of graph.edges) {
    const src = graph.nodes.find((n) => n.id === e.from.nodeId);
    const dst = graph.nodes.find((n) => n.id === e.to.nodeId);
    if (!src || !dst) continue;

    const srcDef = NODE_TYPES[src.type];
    const srcPort = srcDef?.outputs.find((p) => p.name === e.from.port);
    const color = srcPort ? PORT_COLORS[srcPort.type] : "#10b981";

    const a = portCentre(src, e.from.port, "out");
    const b = portCentre(dst, e.to.port, "in");

    positions.push({ id: e.id, x1: a.x, y1: a.y, x2: b.x, y2: b.y, color });
  }

  return (
    <svg
      ref={svgRef}
      className="absolute inset-0 pointer-events-none"
      // CRITICAL: overflow=visible — without this, lines that approach the
      // edges of the SVG's 5000×4000 viewport get clipped. Especially
      // visible when zoomed in or when nodes are placed far apart.
      style={{ width: 5000, height: 4000, overflow: "visible" }}
    >
      <defs>
        <filter id="edge-glow" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="2" />
        </filter>
      </defs>
      {positions.map((p) => {
        const dx = Math.max(40, Math.abs(p.x2 - p.x1) * 0.4);
        const d = `M ${p.x1} ${p.y1} C ${p.x1 + dx} ${p.y1}, ${p.x2 - dx} ${p.y2}, ${p.x2} ${p.y2}`;
        const isHovered = hoveredEdgeId === p.id;
        const midX = (p.x1 + p.x2) / 2;
        const midY = (p.y1 + p.y2) / 2;
        return (
          <g key={p.id}>
            {/* Wide invisible hit area */}
            <path
              d={d}
              stroke="transparent"
              strokeWidth={16}
              fill="none"
              style={{ pointerEvents: "stroke", cursor: "pointer" }}
              onMouseEnter={() => onHover(p.id)}
              onMouseLeave={() => onHover(null)}
              onClick={() => onDelete(p.id)}
            />
            {/* Visible line */}
            <path
              d={d}
              stroke={p.color}
              strokeWidth={isHovered ? 2.5 : 1.5}
              fill="none"
              opacity={isHovered ? 1 : 0.85}
            />
            {isHovered && (
              <foreignObject x={midX - 11} y={midY - 11} width={22} height={22} style={{ pointerEvents: "all" }}>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(p.id);
                  }}
                  className="w-[22px] h-[22px] rounded-full bg-bg-card border border-red-500 text-red-500 hover:bg-red-500 hover:text-white flex items-center justify-center"
                  title="Delete edge"
                >
                  ×
                </button>
              </foreignObject>
            )}
          </g>
        );
      })}
      {draftEdge && (
        <path
          d={`M ${draftEdge.x1} ${draftEdge.y1} C ${draftEdge.x1 + 60} ${draftEdge.y1}, ${draftEdge.x2 - 60} ${draftEdge.y2}, ${draftEdge.x2} ${draftEdge.y2}`}
          stroke={draftEdge.color}
          strokeWidth={1.5}
          fill="none"
          strokeDasharray="4 4"
          opacity={0.6}
        />
      )}
    </svg>
  );
}
