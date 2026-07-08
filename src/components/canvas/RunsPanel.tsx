"use client";

import { useState, useRef } from "react";
import { ChevronDown, ChevronUp, Activity, CheckCircle2, XCircle, Clock } from "lucide-react";

export type RunSummary = {
  id: string;
  name: string;
  status: "running" | "done" | "error" | "cancelled";
  startedAt: number;
  finishedAt?: number;
  totalCostUsd?: number;
  scopeNodeId?: string;
  steps: {
    nodeId: string;
    nodeName: string;
    status: "pending" | "running" | "done" | "error";
    costUsd?: number;
    durationMs?: number;
  }[];
};

export default function RunsPanel({
  runs,
  onClick,
  projectSpentUsd = 0,
  workflowEstimateUsd = 0,
}: {
  runs: RunSummary[];
  onClick?: (runId: string) => void;
  projectSpentUsd?: number;
  workflowEstimateUsd?: number;
}) {
  const [collapsed, setCollapsed] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // Draggable position — offset (px) from the default bottom-right anchor.
  // Default dy lifts the panel above the minimap (which sits bottom-right,
  // ~120px tall + margins) so the two don't overlap out of the box. User
  // can still drag it anywhere.
  const [offset, setOffset] = useState({ dx: 0, dy: -136 });
  const dragState = useRef<{ startX: number; startY: number; baseDx: number; baseDy: number } | null>(null);

  const activeCount = runs.filter((r) => r.status === "running").length;

  function onDragStart(e: React.PointerEvent) {
    // Only start drag from the header bar, and not when clicking the
    // collapse chevron (that's a separate click handler).
    dragState.current = {
      startX: e.clientX,
      startY: e.clientY,
      baseDx: offset.dx,
      baseDy: offset.dy,
    };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function onDragMove(e: React.PointerEvent) {
    const d = dragState.current;
    if (!d) return;
    setOffset({
      dx: d.baseDx + (e.clientX - d.startX),
      dy: d.baseDy + (e.clientY - d.startY),
    });
  }
  function onDragEnd(e: React.PointerEvent) {
    dragState.current = null;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  }

  function toggleExpanded(id: string) {
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  if (runs.length === 0 && workflowEstimateUsd <= 0) return null;
  const fmtUsd = (n: number) => (n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(n >= 0.1 ? 2 : 3)}`);

  return (
    <div
      className="absolute left-4 bottom-4 z-20 w-80 glass r-lg overflow-hidden"
      style={{ transform: `translate(${offset.dx}px, ${offset.dy}px)` }}
    >
      <div
        className="w-full flex items-center gap-2 px-3.5 py-2.5 border-b border-border cursor-move select-none touch-none"
        onPointerDown={onDragStart}
        onPointerMove={onDragMove}
        onPointerUp={onDragEnd}
      >
        <Activity size={13} strokeWidth={1.5} className={activeCount > 0 ? "text-amber-500" : "text-fg-muted"} />
        <span className="text-[12px] font-medium text-fg flex-1 text-left">
          {activeCount > 0 ? `${activeCount} run${activeCount > 1 ? "s" : ""} in progress` : "Recent runs"}
        </span>
        <span className="text-[10px] bg-bg-subtle px-2 py-0.5 rounded-full text-fg-muted">{runs.length}</span>
        {/* Collapse toggle — separate click target so dragging the bar
            doesn't accidentally collapse the panel. */}
        <button
          onClick={() => setCollapsed(!collapsed)}
          onPointerDown={(e) => e.stopPropagation()}
          className="w-5 h-5 rounded flex items-center justify-center hover:bg-bg-hover text-fg-muted"
          title={collapsed ? "Expand" : "Collapse"}
        >
          {collapsed ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        </button>
      </div>

      {/* Cost summary — project spend (actual) + this workflow's per-run
          estimate. Always visible (not gated by the collapse toggle). */}
      <div className="px-3.5 py-2 border-b border-border flex items-center justify-between text-[10px]">
        <span className="text-fg-subtle">Project spent</span>
        <span className="text-fg-muted tabular-nums">{fmtUsd(projectSpentUsd)}</span>
      </div>
      {workflowEstimateUsd > 0 && (
        <div className="px-3.5 py-2 border-b border-border flex items-center justify-between text-[10px]">
          <span className="text-fg-subtle">This workflow (est. / run)</span>
          <span className="text-brand tabular-nums">~{fmtUsd(workflowEstimateUsd)}</span>
        </div>
      )}

      {!collapsed && (
        <div className="max-h-80 overflow-y-auto">
          {runs.map((r) => (
            <div
              key={r.id}
              className="border-b border-border last:border-0 hover:bg-bg-hover transition cursor-pointer"
              onClick={() => {
                toggleExpanded(r.id);
                onClick?.(r.id);
              }}
            >
              <div className="px-3.5 py-2 flex items-center gap-2">
                <StatusGlyph status={r.status} />
                <span className="text-[12px] text-fg flex-1 truncate">{r.name}</span>
                <span className="text-[10px] text-fg-subtle">{elapsed(r)}</span>
              </div>
              <div className="px-3.5 pb-2 text-[10px] text-fg-subtle flex items-center gap-2">
                <span>
                  {r.steps.filter((s) => s.status === "done").length}/{r.steps.length} steps
                </span>
                <span>·</span>
                <span>{r.status}</span>
                {typeof r.totalCostUsd === "number" && r.totalCostUsd > 0 && (
                  <>
                    <span>·</span>
                    <span>${r.totalCostUsd.toFixed(3)}</span>
                  </>
                )}
              </div>
              {expanded.has(r.id) && r.steps.length > 0 && (
                <div className="px-3.5 pb-2 space-y-0.5 border-t border-border bg-bg-subtle/40 pt-2">
                  {r.steps.map((s, i) => (
                    <div key={i} className="flex items-center gap-2 text-[10.5px]">
                      <StatusGlyph status={s.status} small />
                      <span className="flex-1 text-fg-muted truncate">{s.nodeName}</span>
                      <span className="text-fg-subtle">{s.status}</span>
                      {s.durationMs && <span className="text-fg-subtle">{Math.round(s.durationMs / 1000)}s</span>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function StatusGlyph({ status, small = false }: { status: string; small?: boolean }) {
  const size = small ? 9 : 11;
  if (status === "running") return <Clock size={size} className="text-amber-500 animate-pulse" />;
  if (status === "done") return <CheckCircle2 size={size} className="text-emerald-500" />;
  if (status === "error") return <XCircle size={size} className="text-red-500" />;
  return <span className={`inline-block rounded-full bg-fg-subtle/30 ${small ? "w-2 h-2" : "w-2.5 h-2.5"}`} />;
}

function elapsed(r: RunSummary): string {
  const end = r.finishedAt ?? Date.now();
  const sec = Math.round((end - r.startedAt) / 1000);
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m ${sec % 60}s`;
}
