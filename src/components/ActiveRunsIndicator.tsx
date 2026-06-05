"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";

// ─────────────────────────────────────────────────────────────────────────────
// Global active-runs indicator.
//
// Lives in TopNav. Polls /api/runs/active every 5s, but ONLY while there are
// active runs — when the user has nothing running, polling stops entirely and
// the component idles. This is cheap (single SELECT, no joins beyond
// project/brand metadata) so 5s cadence is safe.
//
// Visible states:
//   • Nothing running → renders nothing at all (no clutter)
//   • 1+ running       → small pill: "● 2 running"  (pulses, clickable)
//   • Click pill       → dropdown with each active run, jump-to-workflow link
//
// Also exported as `useActiveRuns()` hook so other parts of the app (Canvas
// toolbar) can read the same live data without a second poller.
// ─────────────────────────────────────────────────────────────────────────────

export type ActiveRun = {
  runId: string;
  workflowId: string;
  workflowName: string;
  projectId: string | null;
  projectName: string | null;
  brandSlug: string | null;
  status: "pending" | "running";
  startedAt: string;
  progress: { total: number; done: number; running: number; errored: number };
  activeNodeIds: string[];
};

type ActiveRunsResponse = { count: number; runs: ActiveRun[] };

// Module-level cache shared by every mounted instance — so the TopNav badge
// and the Canvas toolbar don't double-poll. Implemented with a tiny pub/sub
// pattern; no external state library needed.
class ActiveRunsStore {
  private runs: ActiveRun[] = [];
  private loaded = false;
  private listeners = new Set<() => void>();
  private pollInterval: ReturnType<typeof setTimeout> | null = null;
  private subscribers = 0;
  private inFlight = false;

  getSnapshot(): { runs: ActiveRun[]; loaded: boolean } {
    return { runs: this.runs, loaded: this.loaded };
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    this.subscribers++;
    // First subscriber → kick off polling immediately, then on interval.
    if (this.subscribers === 1) {
      void this.fetchOnce();
      this.startPolling();
    }
    return () => {
      this.listeners.delete(fn);
      this.subscribers--;
      // Last subscriber gone → stop polling to save resources.
      if (this.subscribers === 0) this.stopPolling();
    };
  }

  // Force a fetch — useful right after the user starts a new run so the badge
  // appears within ~100ms instead of waiting the polling interval.
  poke(): void {
    void this.fetchOnce();
  }

  private startPolling() {
    if (this.pollInterval) return;
    void this.fetchOnce().then(() => this.scheduleNext());
  }

  // Poll fast (5s) only while something is running; otherwise back off to 15s
  // to keep idle load (and DB pool pressure) low.
  private scheduleNext() {
    if (this.listeners.size === 0) return;
    const delay = this.runs.length > 0 ? 5000 : 15000;
    this.pollInterval = setTimeout(() => {
      void this.fetchOnce().then(() => this.scheduleNext());
    }, delay);
  }

  private stopPolling() {
    if (this.pollInterval) {
      clearTimeout(this.pollInterval);
      this.pollInterval = null;
    }
  }

  private async fetchOnce() {
    if (this.inFlight) return; // no overlapping fetches
    this.inFlight = true;
    try {
      const res = await fetch("/api/runs/active", { cache: "no-store" });
      if (!res.ok) {
        // 401 means the user logged out — stop polling cleanly.
        if (res.status === 401) this.stopPolling();
        return;
      }
      const data = (await res.json()) as ActiveRunsResponse;
      this.runs = data.runs ?? [];
      this.loaded = true;
      this.listeners.forEach((fn) => fn());
    } catch {
      // Network blip — ignore and try again next tick. Don't notify so the
      // UI keeps showing the last known state.
    } finally {
      this.inFlight = false;
    }
  }
}

// Single global store instance (module singleton, survives HMR in dev).
const globalStore = (globalThis as { __flowlab_activeRunsStore?: ActiveRunsStore }).__flowlab_activeRunsStore ??=
  new ActiveRunsStore();

// React hook — subscribe to the store and re-render on changes.
export function useActiveRuns(): { runs: ActiveRun[]; loaded: boolean } {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const unsub = globalStore.subscribe(() => setTick((t) => t + 1));
    return unsub;
  }, []);
  void tick;
  return globalStore.getSnapshot();
}

// External helper — call this when a new run starts so the badge updates ASAP.
export function pokeActiveRuns(): void {
  globalStore.poke();
}

// ─────────────────────────────────────────────────────────────────────────────
// The actual indicator component used in TopNav.
// ─────────────────────────────────────────────────────────────────────────────

export default function ActiveRunsIndicator() {
  const { runs } = useActiveRuns();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside-click.
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  // Nothing running → render nothing (clean chrome).
  if (runs.length === 0) return null;

  const total = runs.length;
  const label = total === 1 ? "1 running" : `${total} running`;

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-brand/10 hover:bg-brand/15 text-brand text-[11px] font-medium transition"
        title="Active generations"
      >
        <Loader2 size={12} className="animate-spin" />
        <span className="whitespace-nowrap">{label}</span>
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 w-72 max-h-80 overflow-auto rounded-md border border-border bg-bg-card shadow-lg z-50">
          <div className="px-3 py-2 text-[10px] uppercase tracking-wider text-fg-muted border-b border-border">
            Active generations
          </div>
          {runs.map((r) => {
            const href = r.projectId
              ? `/projects/${r.projectId}/workflows/${r.workflowId}`
              : `/dashboard`;
            const startedSec = Math.max(
              0,
              Math.round((Date.now() - new Date(r.startedAt).getTime()) / 1000),
            );
            const min = Math.floor(startedSec / 60);
            const sec = startedSec % 60;
            const ago = min > 0 ? `${min}m ${sec}s` : `${sec}s`;
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
                  {r.progress.done}/{r.progress.total} done · {ago}
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
