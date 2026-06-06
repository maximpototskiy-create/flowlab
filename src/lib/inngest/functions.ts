import { inngest, EVENTS } from "@/lib/inngest/client";
import { executeRunById, markRunError } from "@/lib/engine/runWorkflow";
import { prisma } from "@/lib/prisma";
import type { Graph } from "@/lib/canvas/types";

// Worker that actually runs a workflow. Replaces the old after() background
// task. Key benefits vs after():
//  - concurrency control: caps how many runs execute at once (protects fal.ai /
//    TwelveLabs rate limits and the DB pool) AND keeps it fair across users —
//    one user's burst can't starve everyone else;
//  - retries: a transient crash re-runs automatically;
//  - no request-lifetime ceiling: the run isn't bound to the start request.
export const runWorkflowFn = inngest.createFunction(
  {
    id: "run-workflow",
    // Two concurrency constraints (both apply):
    //  1. Global ceiling — the total number of runs executing simultaneously
    //     across ALL users. This is the main lever protecting external APIs
    //     and the DB pool. Raise as fal.ai/TwelveLabs limits + DB allow.
    //  2. Per-user fairness — keyed by the triggering user's id, so a single
    //     user can occupy at most `limit` slots. A user firing 10 runs takes
    //     2 slots and queues the rest, leaving room for other users to run in
    //     parallel instead of waiting behind them.
    // Tuning knobs: bump #1 for more total throughput, #2 for how many a single
    // user may run at once. Older events without userId fall into one shared
    // per-user bucket (harmless during rollout; all new runs carry userId).
    concurrency: [
      { limit: 8 },
      { key: "event.data.userId", limit: 2 },
    ],
    // One automatic retry on unexpected failure. Node-level results are already
    // persisted by the executor, so a retry resumes cleanly enough for now.
    retries: 1,
    triggers: [{ event: EVENTS.workflowRunRequested }],
  },
  async ({ event, step }) => {
    const { runId, graph, workflowId, scopeNodeId } = event.data as {
      runId: string;
      graph: Graph;
      workflowId: string;
      scopeNodeId?: string;
      userId?: string;
    };

    // Respect cancellation requested before the worker picked the job up.
    const pre = await step.run("check-cancelled", async () => {
      const r = await prisma.run.findUnique({ where: { id: runId }, select: { status: true } });
      return r?.status ?? "missing";
    });
    if (pre === "cancelled" || pre === "missing") {
      return { skipped: true, reason: pre };
    }

    try {
      await executeRunById(runId, graph, workflowId, scopeNodeId);
      return { ok: true, runId };
    } catch (err) {
      // Mark the run as errored so the UI doesn't show a stuck spinner, then
      // rethrow so Inngest records the failure (and applies the retry policy).
      await markRunError(runId, err instanceof Error ? err.message : "Run failed");
      throw err;
    }
  },
);
