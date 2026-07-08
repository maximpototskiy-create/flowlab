"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { NODE_TYPES, PORT_COLORS, getActiveInputs, getActiveOutputs, type Graph, type GraphNode } from "@/lib/canvas/types";
import { NODE_WIDTH, NODE_HEADER_HEIGHT, NODE_PORT_SPACING, PORT_CHIP, PORT_OUTSET } from "./CanvasNode";

type EdgePos = { x1: number; y1: number; x2: number; y2: number; color: string; id: string };

// ─────────────────────────────────────────────────────────────────────────────
// Fallback formula — used while DOM is still mounting, or for the node
// currently being dragged (its DOM position is updated via direct style.transform
// every frame; measuring during drag would be expensive AND stale).
//
// Ports (patch 247) are small chips placed OUTSIDE the node edge. The chip
// container is at `top: y` (y = NODE_HEADER_HEIGHT + 14 + idx * SPACING) with
// the chip at the container origin, so the chip's visual centre is y + CHIP/2.
//
// X for an INPUT port: chip centre sits PORT_OUTSET px LEFT of the node's left
// edge, i.e. node.position.x - PORT_OUTSET.
// X for an OUTPUT port: chip centre sits PORT_OUTSET px RIGHT of the node's
// right edge, i.e. node.position.x + NODE_WIDTH + PORT_OUTSET.
// (Stationary nodes use the pixel-perfect DOM-measured centre; this formula is
// only the first-paint / mid-drag fallback, so it just needs to be close.)
// ─────────────────────────────────────────────────────────────────────────────
const PORT_BASE_Y = NODE_HEADER_HEIGHT + 14 + PORT_CHIP / 2;

function fallbackPortY(node: GraphNode, portName: string, side: "in" | "out"): number {
  const def = NODE_TYPES[node.type];
  if (!def) return PORT_BASE_Y;
  // IMPORTANT: input ports are mode-gated — CanvasNode renders only the
  // ACTIVE inputs via getActiveInputs(def, config), so a port's visual row
  // index is its index in the ACTIVE list, NOT in the full def.inputs.
  // Using def.inputs here made the formula disagree with the measured DOM
  // position, so dragging a node (which switches edges to this formula)
  // made connectors jump downward. Mirror CanvasNode exactly.
  const list = side === "in" ? getActiveInputs(def, node.config) : getActiveOutputs(def, node.config);
  const idx = list.findIndex((p) => p.name === portName);
  return PORT_BASE_Y + (idx < 0 ? 0 : idx) * NODE_PORT_SPACING;
}

export default function CanvasEdges({
  graph,
  hoveredEdgeId,
  draftEdge,
  liveDragNodeId,
  liveDragPos,
  liveDragPositions,
  // dragTick / pan / zoom are passed only to trigger re-render on relevant
  // changes from the parent — we don't read them directly except where noted.
  dragTick,
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
  /** Live positions of all nodes in a multi-node drag, keyed by id. Takes
   *  precedence over liveDragNodeId/liveDragPos when present. */
  liveDragPositions?: Map<string, { x: number; y: number }> | null;
  dragTick?: number;
  pan?: { x: number; y: number };
  zoom?: number;
  onHover: (id: string | null) => void;
  onDelete: (id: string) => void;
}) {
  // Suppress unused-warnings (these props exist to trigger re-renders).
  void dragTick;

  // Cache of measured port centres in canvas-local coords, keyed by
  // `${nodeId}::${portName}::${side}`. Filled by useLayoutEffect — guarantees
  // pixel-perfect alignment regardless of CSS quirks (borders, antialiasing,
  // box-sizing differences across browsers).
  const measuredRef = useRef<Map<string, { x: number; y: number }>>(new Map());
  // Bump on every successful re-measure so React rerenders the SVG with new
  // positions. We store the cache in a ref (not useState) so writing to it
  // doesn't itself cause a re-render loop.
  const [measureVersion, setMeasureVersion] = useState(0);
  const svgRef = useRef<SVGSVGElement>(null);

  useLayoutEffect(() => {
    if (!svgRef.current) return;
    const svgRect = svgRef.current.getBoundingClientRect();
    const z = zoom ?? 1;
    const next = new Map<string, { x: number; y: number }>();

    // Find every port element in the document and record its centre in
    // canvas-local coords. The SVG lives inside the same transform parent
    // as the nodes — both rects reflect the same applied pan/zoom — so
    // (port_rect - svg_rect) / zoom gives canvas-local (pre-transform) coords.
    const portEls = document.querySelectorAll<HTMLElement>("[data-port-side]");
    portEls.forEach((el) => {
      const nodeEl = el.closest<HTMLElement>("[data-node-id]");
      if (!nodeEl) return;
      const nodeId = nodeEl.getAttribute("data-node-id");
      const portId = el.getAttribute("data-port-id");
      const side = el.getAttribute("data-port-side") as "in" | "out" | null;
      if (!nodeId || !portId || !side) return;
      const rect = el.getBoundingClientRect();
      const cx = (rect.left + rect.width / 2 - svgRect.left) / z;
      const cy = (rect.top + rect.height / 2 - svgRect.top) / z;
      next.set(`${nodeId}::${portId}::${side}`, { x: cx, y: cy });
    });

    // Compare to previous; only bump the version if positions actually changed.
    // Without this we'd re-render on every layout effect even when nothing moved.
    const prev = measuredRef.current;
    let changed = prev.size !== next.size;
    if (!changed) {
      for (const [k, v] of next) {
        const p = prev.get(k);
        if (!p || p.x !== v.x || p.y !== v.y) {
          changed = true;
          break;
        }
      }
    }
    if (changed) {
      measuredRef.current = next;
      setMeasureVersion((v) => v + 1);
    }
    // Re-measure whenever any node mutates (add, delete, drag-end commits a
    // new position) or transforms change. liveDragPos is intentionally NOT in
    // deps — the dragged node's position is handled via the fallback formula.
  }, [graph.nodes, graph.edges, pan?.x, pan?.y, zoom]);

  // Helper: live drag position of a node if it's being dragged (handles
  // both single-node liveDragPos and multi-node liveDragPositions map).
  function livePosOf(nodeId: string): { x: number; y: number } | null {
    if (liveDragPositions && liveDragPositions.has(nodeId)) {
      return liveDragPositions.get(nodeId)!;
    }
    if (liveDragNodeId === nodeId && liveDragPos) return liveDragPos;
    return null;
  }

  // Helper: position of a node (possibly overridden by live drag).
  function posOf(n: GraphNode): { x: number; y: number } {
    return livePosOf(n.id) ?? n.position;
  }

  // Helper: port centre — measured first, formula fallback.
  function portCentre(node: GraphNode, portName: string, side: "in" | "out"): { x: number; y: number } {
    const key = `${node.id}::${portName}::${side}`;
    const m = measuredRef.current.get(key);
    const live = livePosOf(node.id);

    // Node being dragged: shift its MEASURED port position by how far the
    // node has moved (live - committed position). This is exact — it reuses
    // the real DOM-measured offset instead of the formula, so connectors
    // stay glued to ports during drag (single or multi-node).
    if (live && m) {
      const dx = live.x - node.position.x;
      const dy = live.y - node.position.y;
      return { x: m.x + dx, y: m.y + dy };
    }

    if (m && !live) {
      // Stationary node — pixel-perfect measured value.
      return m;
    }

    // Fallback: formula (first paint / not yet measured / dragging an
    // unmeasured port). Chip centres sit PORT_OUTSET px outside the node edge.
    const p = posOf(node);
    const y = p.y + fallbackPortY(node, portName, side);
    const x = side === "out" ? p.x + NODE_WIDTH + PORT_OUTSET : p.x - PORT_OUTSET;
    return { x, y };
  }

  // Reference measureVersion so React knows this render depends on it.
  void measureVersion;

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
      // edges of the SVG's 5000×4000 viewport get clipped. Without it parts
      // of lines just disappear (the symptom you saw on the screenshot).
      style={{ width: 5000, height: 4000, overflow: "visible" }}
    >
      <defs>
        <filter id="edge-glow" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="2" />
        </filter>
      </defs>
      {positions.map((p) => {
        // Less aggressive control offset so lines don't make giant S-curves
        // when nodes are placed far apart. Clamped to keep readable shapes
        // at all zoom levels.
        const dist = Math.abs(p.x2 - p.x1);
        const dx = Math.max(40, Math.min(140, dist * 0.35));
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
              <foreignObject
                x={midX - 11}
                y={midY - 11}
                width={22}
                height={22}
                style={{ pointerEvents: "all" }}
              >
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
