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
    // Concurrency = how many WORKFLOW RUNS execute at once (NOT how many nodes —
    // the 50 nodes inside one run are parallelised in-process by the executor,
    // and Inngest sees the whole run as a single function). This is a global
    // safety valve, not a per-user throttle: it protects the Postgres pool
    // (connection_limit=15 in prisma.ts) and fal.ai / TwelveLabs rate limits.
    // MUST be <= the Inngest plan's concurrency limit, otherwise the dashboard
    // warns and clamps it. Free plan = 5. Set INNGEST_CONCURRENCY in env to
    // raise it after upgrading the plan (and pair with a bigger DB pool). A
    // 6th simultaneous run doesn't fail — it queues until a slot frees up.
    concurrency: { limit: Number(process.env.INNGEST_CONCURRENCY) || 5 },
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
