"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { useActiveRuns } from "../ActiveRunsIndicator";

// Sits inside CanvasToolbar to show other workflows that have active runs
// while you're focused on this workflow. Same data source as the TopNav
// indicator (shared store), so no extra polling overhead.
//
// Renders nothing when no OTHER workflows are running.

export default function OtherActiveRunsBadge({
  currentWorkflowId,
}: {
  currentWorkflowId: string;
}) {
  const { runs } = useActiveRuns();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  const others = runs.filter((r) => r.workflowId !== currentWorkflowId);
  if (others.length === 0) return null;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="hidden md:inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-brand/40 bg-brand/10 hover:bg-brand/15 text-[11.5px] text-brand"
        title="Generations running in other workflows"
      >
        <Loader2 size={11} className="animate-spin" />
        {others.length === 1 ? "1 elsewhere" : `${others.length} elsewhere`}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1.5 w-72 max-h-80 overflow-auto glass r-sm z-50">
          <div className="px-3 py-2 text-[10px] uppercase tracking-wider text-fg-muted border-b border-border">
            Running in other workflows
          </div>
          {others.map((r) => {
            const href = r.projectId
              ? `/projects/${r.projectId}/workflows/${r.workflowId}`
              : `/dashboard`;
            return (
              <Link
                key={r.runId}
                href={href}
                className="block px-3 py-2 hover:bg-bg-subtle border-b border-border/60 last:border-b-0"
                onClick={() => setOpen(false)}
              >
                <div className="flex items-center gap-2">
                  <Loader2 size={11} className="animate-spin text-brand shrink-0" />
                  <span className="text-[12px] font-medium truncate">
                    {r.workflowName}
                  </span>
                </div>
                <div className="mt-0.5 text-[10px] text-fg-muted truncate">
                  {r.projectName ? `${r.projectName} · ` : ""}
                  {r.progress.done}/{r.progress.total} done
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
