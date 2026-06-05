import { inngest, EVENTS } from "@/lib/inngest/client";
import { executeRunById, markRunError } from "@/lib/engine/runWorkflow";
import { prisma } from "@/lib/prisma";
import type { Graph } from "@/lib/canvas/types";

// Worker that actually runs a workflow. Replaces the old after() background
// task. Key benefits vs after():
//  - concurrency control: at most N runs execute at once across the whole app,
//    which protects fal.ai / TwelveLabs rate limits and the DB pool;
//  - retries: a transient crash re-runs automatically;
//  - no request-lifetime ceiling: the run isn't bound to the start request.
export const runWorkflowFn = inngest.createFunction(
  {
    id: "run-workflow",
    // Global cap on simultaneously executing runs. Tune as capacity grows.
    // This is the main lever protecting external APIs and the DB under load.
    concurrency: { limit: 5 },
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
