// Shared workflow-run execution. Extracted from /api/runs/start so it can be
// invoked from the Inngest queue worker (with retries + concurrency control)
// instead of running inline in the request's after() background task.
import { prisma } from "@/lib/prisma";
import { executeGraph, ancestorsOf } from "@/lib/engine/executor";
import { buildBrandContext, getBrandUiScreenshots } from "@/lib/engine/brandContext";
import type { Graph } from "@/lib/canvas/types";

export async function executeRun(
  runId: string,
  graph: Graph,
  workflow: { id: string; projectId: string; project: { brandId: string | null } },
  scopeNodeId?: string,
) {
  console.log(`[executeRun] ${runId} starting; scope=${scopeNodeId ?? "all"}`);
  const scope = scopeNodeId ? ancestorsOf(graph, scopeNodeId) : undefined;
  const brandVoice = await buildBrandContext(workflow.project.brandId);
  const brandUiScreenshots = await getBrandUiScreenshots(workflow.project.brandId);

  const result = await executeGraph(
    graph,
    {
      brandId: workflow.project.brandId,
      projectId: workflow.projectId,
      workflowId: workflow.id,
      brandVoice,
      brandUiScreenshots,
    },
    { runId, scope, scopeNodeId },
  );
  console.log(`[executeRun] ${runId} executeGraph returned; errors=${result.errors.size}, cost=${result.totalCost}`);

  const current = await prisma.run.findUnique({ where: { id: runId }, select: { status: true } });
  if (current?.status === "cancelled") {
    console.log(`[executeRun] ${runId} was cancelled, not updating`);
    return;
  }

  await prisma.run.update({
    where: { id: runId },
    data: {
      status: result.errors.size > 0 ? "error" : "done",
      finishedAt: new Date(),
      totalCostUsd: result.totalCost,
      errorMessage: result.errors.size > 0 ? [...result.errors.values()][0] : null,
    },
  });
  console.log(`[executeRun] ${runId} marked ${result.errors.size > 0 ? "error" : "done"}`);
}

// Loads the workflow then runs it. Used by the Inngest worker, which only
// receives ids in the event payload (keeps event size small).
export async function executeRunById(runId: string, graph: Graph, workflowId: string, scopeNodeId?: string) {
  const workflow = await prisma.workflow.findUnique({
    where: { id: workflowId },
    select: { id: true, projectId: true, project: { select: { brandId: true } } },
  });
  if (!workflow) throw new Error(`Workflow ${workflowId} not found`);
  await executeRun(runId, graph, workflow, scopeNodeId);
}

export async function markRunError(runId: string, message: string) {
  await prisma.run
    .update({
      where: { id: runId },
      data: { status: "error", finishedAt: new Date(), errorMessage: message },
    })
    .catch((e: unknown) => console.error(`[executeRun] ${runId} failed to mark error:`, e));
}
