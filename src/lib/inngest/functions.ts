import { inngest, EVENTS } from "@/lib/inngest/client";
import { markRunError, mergePersistedOutputs } from "@/lib/engine/runWorkflow";
import { planRun, runSingleNode, type NodeStepResult } from "@/lib/engine/executor";
import { buildBrandContext, getBrandUiScreenshots } from "@/lib/engine/brandContext";
import { prisma } from "@/lib/prisma";
import type { Graph } from "@/lib/canvas/types";

// Worker that runs a workflow as GRANULAR Inngest steps - one step.run per
// node (patch 343). Completed steps are memoised by Inngest, so:
//  - a transient failure (fal hiccup, timeout) retries ONLY the failed node,
//    not the whole workflow - finished generations are never re-billed;
//  - a crash/restart resumes from the exact node that was executing;
//  - the per-workflow concurrency key still serialises runs of one board.
// Node outputs flow between steps as plain JSON (URLs/text), and each node
// also persists its outputs into workflow.graph as before - the UI polling
// path is unchanged.
export const runWorkflowFn = inngest.createFunction(
  {
    id: "run-workflow",
    concurrency: [
      { limit: Number(process.env.INNGEST_CONCURRENCY) || 5 },
      // Queue semantics via the event's queueKey: FULL runs of one workflow
      // share "<workflowId>:full" and serialise; MANUAL scoped runs carry
      // their unique runId, so hand-started nodes execute in PARALLEL.
      // Shared-ancestor races between parallel runs are closed by the JIT
      // reuse check inside runSingleNode.
      { key: "event.data.queueKey", limit: 1 },
    ],
    // One automatic retry. With per-node steps this is a TARGETED retry:
    // memoised (finished) nodes are skipped, only unfinished ones re-execute.
    retries: 1,
    triggers: [{ event: EVENTS.workflowRunRequested }],
  },
  async ({ event, step }) => {
    const { runId, graph, workflowId, scopeNodeId } = event.data as {
      runId: string;
      graph: Graph;
      workflowId: string;
      scopeNodeId?: string | string[];
      userId?: string;
      queueKey?: string;
    };
    const scopeIds = Array.isArray(scopeNodeId) ? scopeNodeId : scopeNodeId ? [scopeNodeId] : [];

    // Respect cancellation requested before the worker picked the job up.
    const pre = await step.run("check-cancelled", async () => {
      const r = await prisma.run.findUnique({ where: { id: runId }, select: { status: true } });
      return r?.status ?? "missing";
    });
    if (pre === "cancelled" || pre === "missing") {
      return { skipped: true, reason: pre };
    }

    try {
      // PLAN: merge freshest persisted outputs (earlier runs of this board),
      // load brand context, compute layers + reusable cache. Everything the
      // later steps need is returned as JSON so retries are deterministic -
      // on a function re-run this step is memoised and NOT re-executed.
      const plan = await step.run("plan", async () => {
        const workflow = await prisma.workflow.findUnique({
          where: { id: workflowId },
          select: { id: true, projectId: true, project: { select: { brandId: true } } },
        });
        if (!workflow) throw new Error(`Workflow ${workflowId} not found`);
        if (scopeIds.length) await mergePersistedOutputs(graph, workflowId);
        const [brandVoice, brandUiScreenshots] = await Promise.all([
          buildBrandContext(workflow.project.brandId),
          getBrandUiScreenshots(workflow.project.brandId),
        ]);
        const p = planRun(graph, scopeIds.length ? scopeIds : undefined);
        console.log(`[runWorkflowFn] ${runId} plan: ${p.layers.length} layers, ${Object.keys(p.cachedOutputs).length} cached`);
        return {
          ...p,
          ctx: {
            brandId: workflow.project.brandId,
            projectId: workflow.projectId,
            workflowId: workflow.id,
            brandVoice,
            brandUiScreenshots,
          },
        };
      });

      // Accumulated node outputs: reusable cache + every finished step.
      const outputs: Record<string, Record<string, unknown>> = { ...plan.cachedOutputs };
      const results: Record<string, { value: string; mime?: string }[]> = { ...plan.cachedResults };
      let totalCost = 0;

      for (let li = 0; li < plan.layers.length; li++) {
        const layer = plan.layers[li];
        // Cancellation between layers (plain query - not worth a step).
        const fresh = await prisma.run.findUnique({ where: { id: runId }, select: { status: true } });
        if (fresh?.status === "cancelled") {
          return { cancelled: true, runId };
        }
        // One Inngest step per node; parallel within the layer. A rejected
        // step fails this attempt -> Inngest re-runs the function, memoised
        // steps are skipped, ONLY the failed node executes again.
        const stepResults = await Promise.all(
          layer.map((nodeId) =>
            step.run(`node-${nodeId}`, (): Promise<NodeStepResult> =>
              // Requested nodes always execute; ancestors may JIT-reuse a
              // result persisted by a concurrent run. Full runs re-run all.
              runSingleNode(graph, nodeId, { outputs, results }, plan.ctx, runId, {
                alwaysRun: scopeIds.length === 0 || scopeIds.includes(nodeId),
              }),
            ),
          ),
        );
        stepResults.forEach((r, i) => {
          const id = layer[i];
          outputs[id] = r.outputs;
          if (r.results) results[id] = r.results;
          totalCost += r.costUsd;
        });
      }

      await step.run("finalize", async () => {
        const current = await prisma.run.findUnique({ where: { id: runId }, select: { status: true } });
        if (current?.status === "cancelled") return;
        await prisma.run.update({
          where: { id: runId },
          data: { status: "done", finishedAt: new Date(), totalCostUsd: totalCost, errorMessage: null },
        });
      });
      return { ok: true, runId, cost: totalCost };
    } catch (err) {
      // Mark the run as errored so the UI doesn't show a stuck spinner, then
      // rethrow so Inngest records the failure (and applies the retry policy).
      await markRunError(runId, err instanceof Error ? err.message : "Run failed");
      throw err;
    }
  },
);
