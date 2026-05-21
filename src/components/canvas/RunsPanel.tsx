"use client";

import { useState } from "react";
import { ChevronDown, ChevronUp, Activity, CheckCircle2, XCircle, Clock } from "lucide-react";

export type RunSummary = {
  id: string;
  name: string;
  status: "running" | "done" | "error" | "cancelled";
  startedAt: number;
  finishedAt?: number;
  totalCostUsd?: number;
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
}: {
  runs: RunSummary[];
  onClick?: (runId: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const activeCount = runs.filter((r) => r.status === "running").length;

  function toggleExpanded(id: string) {
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  if (runs.length === 0) return null;

  return (
    <div className="absolute right-4 bottom-4 z-20 w-80 rounded-xl bg-bg-card border border-border shadow-panel overflow-hidden">
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="w-full flex items-center gap-2 px-3.5 py-2.5 hover:bg-bg-hover border-b border-border"
      >
        <Activity size={13} strokeWidth={1.5} className={activeCount > 0 ? "text-amber-500" : "text-fg-muted"} />
        <span className="text-[12px] font-medium text-fg flex-1 text-left">
          {activeCount > 0 ? `${activeCount} run${activeCount > 1 ? "s" : ""} in progress` : "Recent runs"}
        </span>
        <span className="text-[10px] bg-bg-subtle px-2 py-0.5 rounded-full text-fg-muted">{runs.length}</span>
        {collapsed ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
      </button>

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
