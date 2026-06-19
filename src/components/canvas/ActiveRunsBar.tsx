"use client";

import { Loader2, X, Square } from "lucide-react";
import type { RunSummary } from "./RunsPanel";

// A prominent strip at the top-centre of the canvas listing every in-flight run
// with a per-run Stop button (and Stop all when there's more than one). Driven
// by the same `runs` state the rest of the canvas uses, so it appears the
// instant a run is started optimistically and disappears when runs settle.
export default function ActiveRunsBar({
  runs,
  onStop,
  onStopAll,
}: {
  runs: RunSummary[];
  onStop: (runId: string) => void;
  onStopAll: () => void;
}) {
  const active = runs.filter((r) => r.status === "running");
  if (active.length === 0) return null;

  return (
    <div className="absolute top-3 left-1/2 -translate-x-1/2 z-30 max-w-[88%] pointer-events-none">
      <div className="pointer-events-auto flex items-center gap-2 px-2.5 py-1.5 rounded-full bg-bg-card/95 backdrop-blur hairline elev-2">
        <Loader2 size={14} className="animate-spin text-brand shrink-0" />
        <span className="text-[11px] font-semibold text-fg shrink-0">
          {active.length} running
        </span>

        <div className="flex items-center gap-1 overflow-x-auto max-w-[52vw]">
          {active.map((r) => (
            <span
              key={r.id}
              className="inline-flex items-center gap-1 pl-2 pr-0.5 py-0.5 rounded-full bg-bg border border-border text-[10px] text-fg-muted shrink-0"
              title={r.name}
            >
              <span className="max-w-[150px] truncate">{r.name}</span>
              <button
                onClick={() => onStop(r.id)}
                title="Stop this run"
                className="w-4 h-4 grid place-items-center rounded-full text-fg-subtle hover:bg-red-600 hover:text-white transition"
              >
                <X size={10} />
              </button>
            </span>
          ))}
        </div>

        {active.length > 1 && (
          <button
            onClick={onStopAll}
            className="ml-0.5 inline-flex items-center gap-1 px-2 py-1 rounded-full bg-red-600/90 hover:bg-red-600 text-white text-[10px] font-semibold shrink-0 transition"
          >
            <Square size={9} fill="currentColor" /> Stop all
          </button>
        )}
      </div>
    </div>
  );
}
