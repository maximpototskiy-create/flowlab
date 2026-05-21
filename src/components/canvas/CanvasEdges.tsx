"use client";

import { NODE_TYPES, PORT_COLORS, type Graph, type GraphNode } from "@/lib/canvas/types";
import { NODE_WIDTH, NODE_HEADER_HEIGHT, NODE_PORT_SPACING } from "./CanvasNode";

type EdgePos = { x1: number; y1: number; x2: number; y2: number; color: string; id: string };

const PORT_BASE = NODE_HEADER_HEIGHT + 14;

function portY(node: GraphNode, portName: string, side: "in" | "out"): number {
  const def = NODE_TYPES[node.type];
  if (!def) return PORT_BASE;
  const list = side === "in" ? def.inputs : def.outputs;
  const idx = list.findIndex((p) => p.name === portName);
  return PORT_BASE + (idx < 0 ? 0 : idx) * NODE_PORT_SPACING;
}

export default function CanvasEdges({
  graph,
  hoveredEdgeId,
  draftEdge,
  onHover,
  onDelete,
}: {
  graph: Graph;
  hoveredEdgeId: string | null;
  draftEdge: { x1: number; y1: number; x2: number; y2: number; color: string } | null;
  onHover: (id: string | null) => void;
  onDelete: (id: string) => void;
}) {
  const positions: EdgePos[] = [];
  for (const e of graph.edges) {
    const src = graph.nodes.find((n) => n.id === e.from.nodeId);
    const dst = graph.nodes.find((n) => n.id === e.to.nodeId);
    if (!src || !dst) continue;
    const srcDef = NODE_TYPES[src.type];
    const srcPort = srcDef?.outputs.find((p) => p.name === e.from.port);
    const color = srcPort ? PORT_COLORS[srcPort.type] : "#10b981";
    positions.push({
      id: e.id,
      x1: src.position.x + NODE_WIDTH,
      y1: src.position.y + portY(src, e.from.port, "out"),
      x2: dst.position.x,
      y2: dst.position.y + portY(dst, e.to.port, "in"),
      color,
    });
  }

  return (
    <svg className="absolute inset-0 pointer-events-none" style={{ width: 5000, height: 4000 }}>
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
