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
    // Concurrency: a single global ceiling (see note below). No per-user cap —
    // any user may run as many generations simultaneously as they want.
    // Per-user fairness is intentionally OFF: any single user may run as many
    // generations at once as they like. What remains is a single high GLOBAL
    // ceiling acting as a safety valve, NOT a throttle. It exists because the
    // real bottlenecks under a burst are (a) the Postgres pool
    // (connection_limit=15 in prisma.ts) and (b) fal.ai / TwelveLabs rate
    // limits — a truly unlimited cap can re-trigger the P2024 pool-timeout
    // cascade that patches 78–80 fixed. 50 is far above realistic peak for the
    // current team. To go higher (or fully unlimited), raise/remove this line —
    // but pair it with a bigger DB pool and a check on the external API limits.
    concurrency: { limit: 50 },
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
