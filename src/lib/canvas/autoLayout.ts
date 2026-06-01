// Auto-layout: arrange nodes left-to-right by data flow (layered DAG /
// Sugiyama-lite). A node's column = longest path from any root; nodes in
// the same column are stacked vertically and centered. Pure function —
// takes nodes+edges, returns new positions. No side effects.

import type { GraphNode, GraphEdge } from "@/lib/canvas/types";

export function autoLayout(
  nodes: GraphNode[],
  edges: GraphEdge[],
  opts?: { gapX?: number; gapY?: number; nodeH?: number; originX?: number; originY?: number },
): Map<string, { x: number; y: number }> {
  const GAP_X = opts?.gapX ?? 360; // ~NODE_WIDTH(280) + breathing room
  const GAP_Y = opts?.gapY ?? 60;
  const NODE_H = opts?.nodeH ?? 120; // representative node height
  const ORIGIN_X = opts?.originX ?? 120;
  const ORIGIN_Y = opts?.originY ?? 120;

  const ids = new Set(nodes.map((n) => n.id));
  const incoming = new Map<string, string[]>();
  for (const n of nodes) incoming.set(n.id, []);
  for (const e of edges) {
    if (ids.has(e.from.nodeId) && ids.has(e.to.nodeId)) {
      incoming.get(e.to.nodeId)!.push(e.from.nodeId);
    }
  }

  // Column index = longest path from a root (node with no incoming edges).
  // DFS with memoization; a visiting-set guards against cycles (treats the
  // back-edge as contributing 0 so we never infinite-loop).
  const layer = new Map<string, number>();
  const visiting = new Set<string>();
  function computeLayer(id: string): number {
    const cached = layer.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) return 0; // cycle guard
    visiting.add(id);
    let l = 0;
    for (const p of incoming.get(id) ?? []) {
      l = Math.max(l, computeLayer(p) + 1);
    }
    visiting.delete(id);
    layer.set(id, l);
    return l;
  }
  for (const n of nodes) computeLayer(n.id);

  // Group node ids by column, preserving a stable order (original array
  // order) so layout is deterministic.
  const byLayer = new Map<number, string[]>();
  for (const n of nodes) {
    const l = layer.get(n.id) ?? 0;
    if (!byLayer.has(l)) byLayer.set(l, []);
    byLayer.get(l)!.push(n.id);
  }

  // Assign positions. Each column is centered vertically around 0, then the
  // whole layout is shifted so its top-left sits at (ORIGIN_X, ORIGIN_Y).
  const pos = new Map<string, { x: number; y: number }>();
  for (const [l, colIds] of byLayer) {
    const colHeight = colIds.length * NODE_H + (colIds.length - 1) * GAP_Y;
    const startY = -colHeight / 2;
    colIds.forEach((id, i) => {
      pos.set(id, { x: l * GAP_X, y: startY + i * (NODE_H + GAP_Y) });
    });
  }

  let minX = Infinity;
  let minY = Infinity;
  for (const p of pos.values()) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
  }
  if (!Number.isFinite(minX)) {
    minX = 0;
    minY = 0;
  }
  for (const [id, p] of pos) {
    pos.set(id, { x: p.x - minX + ORIGIN_X, y: p.y - minY + ORIGIN_Y });
  }

  return pos;
}
