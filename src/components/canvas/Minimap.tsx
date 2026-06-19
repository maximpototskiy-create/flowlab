"use client";

import { useMemo } from "react";
import type { GraphNode } from "@/lib/canvas/types";

// Minimap — a small overview of the whole graph rendered in the corner.
// Shows every node as a dot and a rectangle for the current viewport.
// Clicking anywhere re-centers the canvas on that point.
//
// Fully isolated: takes nodes + viewport state, emits a new pan. Does NOT
// touch selection, drag, or edge logic.

const MM_W = 180; // minimap width in px
const MM_H = 120; // minimap height in px
const MM_PAD = 8; // inner padding so dots aren't flush to the edge
// Approximate node footprint in graph units. Width is exact (NODE_WIDTH),
// height varies with content so we use a representative value — the minimap
// is a rough overview, pixel accuracy isn't needed.
const NODE_H_APPROX = 90;

export default function Minimap({
  nodes,
  nodeWidth,
  pan,
  zoom,
  viewportSize,
  onNavigate,
}: {
  nodes: GraphNode[];
  nodeWidth: number;
  pan: { x: number; y: number };
  zoom: number;
  viewportSize: { w: number; h: number };
  /** Emit a new pan so the given graph point becomes the viewport center. */
  onNavigate: (pan: { x: number; y: number }) => void;
}) {
  const layout = useMemo(() => {
    if (nodes.length === 0) return null;

    // Bounding box of all nodes in graph coordinates.
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const n of nodes) {
      minX = Math.min(minX, n.position.x);
      minY = Math.min(minY, n.position.y);
      maxX = Math.max(maxX, n.position.x + nodeWidth);
      maxY = Math.max(maxY, n.position.y + NODE_H_APPROX);
    }

    // Also include the current viewport in the bbox so the viewport rect
    // is always visible even when the user panned away from all nodes.
    const vpX = -pan.x / zoom;
    const vpY = -pan.y / zoom;
    const vpW = viewportSize.w / zoom;
    const vpH = viewportSize.h / zoom;
    minX = Math.min(minX, vpX);
    minY = Math.min(minY, vpY);
    maxX = Math.max(maxX, vpX + vpW);
    maxY = Math.max(maxY, vpY + vpH);

    const bboxW = Math.max(1, maxX - minX);
    const bboxH = Math.max(1, maxY - minY);

    // Scale to fit bbox inside the minimap (minus padding), keep aspect.
    const scale = Math.min(
      (MM_W - MM_PAD * 2) / bboxW,
      (MM_H - MM_PAD * 2) / bboxH,
    );

    // Center the scaled content in the minimap.
    const offsetX = MM_PAD + (MM_W - MM_PAD * 2 - bboxW * scale) / 2;
    const offsetY = MM_PAD + (MM_H - MM_PAD * 2 - bboxH * scale) / 2;

    const toMM = (gx: number, gy: number) => ({
      x: offsetX + (gx - minX) * scale,
      y: offsetY + (gy - minY) * scale,
    });

    const dots = nodes.map((n) => {
      const p = toMM(n.position.x, n.position.y);
      return {
        id: n.id,
        x: p.x,
        y: p.y,
        w: Math.max(2, nodeWidth * scale),
        h: Math.max(2, NODE_H_APPROX * scale),
      };
    });

    const vp = toMM(vpX, vpY);
    const viewport = {
      x: vp.x,
      y: vp.y,
      w: vpW * scale,
      h: vpH * scale,
    };

    return { scale, minX, minY, offsetX, offsetY, dots, viewport };
  }, [nodes, nodeWidth, pan, zoom, viewportSize]);

  if (!layout) return null;

  // Click on minimap → translate the clicked minimap point back to graph
  // coordinates and set pan so that point becomes the viewport center.
  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    const mmX = e.clientX - rect.left;
    const mmY = e.clientY - rect.top;
    // Inverse of toMM.
    const gx = layout.minX + (mmX - layout.offsetX) / layout.scale;
    const gy = layout.minY + (mmY - layout.offsetY) / layout.scale;
    // Center viewport on (gx, gy): pan = -(g * zoom) + halfViewport.
    onNavigate({
      x: -gx * zoom + viewportSize.w / 2,
      y: -gy * zoom + viewportSize.h / 2,
    });
  };

  return (
    <div
      className="absolute bottom-4 right-4 z-10 glass r-md overflow-hidden cursor-pointer"
      style={{ width: MM_W, height: MM_H }}
      onClick={handleClick}
      onPointerDown={(e) => e.stopPropagation()}
      title="Click to navigate"
    >
      <svg width={MM_W} height={MM_H}>
        {/* Node dots */}
        {layout.dots.map((d) => (
          <rect
            key={d.id}
            x={d.x}
            y={d.y}
            width={d.w}
            height={d.h}
            rx={1.5}
            fill="rgb(var(--fg-subtle) / 0.5)"
          />
        ))}
        {/* Viewport rectangle */}
        <rect
          x={layout.viewport.x}
          y={layout.viewport.y}
          width={layout.viewport.w}
          height={layout.viewport.h}
          rx={2}
          fill="none"
          stroke="rgb(var(--brand))"
          strokeWidth={1.5}
        />
      </svg>
    </div>
  );
}
