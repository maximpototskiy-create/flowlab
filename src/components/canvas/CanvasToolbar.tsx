"use client";

import { Play, Square, Loader2, Check, History, BookOpen } from "lucide-react";
import ThemeToggle from "../ThemeToggle";
import Link from "next/link";

export default function CanvasToolbar({
  workflowName,
  saveState,
  isRunning,
  runCount,
  onRunAll,
  onStopAll,
  brandSlug,
  projectId,
  workflowId,
}: {
  workflowName: string;
  saveState: "idle" | "saving" | "saved" | "error";
  isRunning: boolean;
  runCount: number;
  onRunAll: () => void;
  onStopAll?: () => void;
  brandSlug?: string | null;
  projectId: string;
  workflowId: string;
}) {
  return (
    <div className="h-12 shrink-0 border-b border-border bg-bg-card px-4 flex items-center gap-3">
      <Link
        href={`/projects/${projectId}`}
        className="text-[12px] text-fg-muted hover:text-fg"
      >
        ← Workflows
      </Link>

      <div className="text-fg-subtle">/</div>

      <div className="flex items-center gap-2 flex-1 min-w-0">
        <span className="text-[13px] font-medium text-fg truncate">{workflowName}</span>
        <SaveIndicator state={saveState} />
      </div>

      <div className="flex items-center gap-1.5">
        {brandSlug && (
          <Link
            href={`/brands/${brandSlug}/brand-kit`}
            className="hidden md:inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-border bg-bg hover:bg-bg-hover text-[11.5px] text-fg-muted hover:text-fg"
          >
            <BookOpen size={11} strokeWidth={1.5} />
            Brand Kit
          </Link>
        )}
        <Link
          href={`/projects/${projectId}/workflows/${workflowId}/runs`}
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-border bg-bg hover:bg-bg-hover text-[11.5px] text-fg-muted hover:text-fg"
        >
          <History size={11} strokeWidth={1.5} />
          Runs
          {runCount > 0 && (
            <span className="text-[9px] bg-bg-subtle px-1.5 rounded-full text-fg-subtle">{runCount}</span>
          )}
        </Link>

        <ThemeToggle />

        {isRunning && onStopAll && (
          <button
            onClick={onStopAll}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-red-500/40 bg-red-500/10 hover:bg-red-500/20 text-red-600 dark:text-red-400 text-[12px] font-medium"
            title="Stop all running nodes"
          >
            <Square size={11} fill="currentColor" />
            Stop
          </button>
        )}

        <button
          onClick={onRunAll}
          className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-md bg-fg text-bg hover:opacity-90 text-[12px] font-medium"
        >
          {isRunning ? (
            <>
              <Loader2 size={12} className="animate-spin" />
              Running…
            </>
          ) : (
            <>
              <Play size={11} fill="currentColor" />
              Run all
            </>
          )}
        </button>
      </div>
    </div>
  );
}

function SaveIndicator({ state }: { state: "idle" | "saving" | "saved" | "error" }) {
  if (state === "saving") {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] text-fg-subtle">
        <Loader2 size={9} className="animate-spin" />
        Saving…
      </span>
    );
  }
  if (state === "saved") {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] text-emerald-500">
        <Check size={9} />
        Saved
      </span>
    );
  }
  if (state === "error") {
    return <span className="text-[10px] text-red-500">Save failed</span>;
  }
  return null;
}
