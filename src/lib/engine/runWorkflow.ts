// Shared workflow-run execution. Extracted from /api/runs/start so it can be
// invoked from the Inngest queue worker (with retries + concurrency control)
// instead of running inline in the request's after() background task.
import { prisma } from "@/lib/prisma";
import { executeGraph, ancestorsOf } from "@/lib/engine/executor";
import { buildBrandContext, getBrandUiScreenshots } from "@/lib/engine/brandContext";
import type { Graph, GraphNode } from "@/lib/canvas/types";

// Merge the freshest persisted node outputs from workflow.graph (DB) into the
// run's graph snapshot. The snapshot is captured client-side at enqueue time;
// with per-workflow serialisation on the queue an EARLIER run may have already
// produced outputs this run can reuse. Without this merge, mass ▶ clicks on
// several nodes re-generated their shared ancestors once per run (duplicate
// generations, racing persists). Config/edges/positions stay from the snapshot
// (the user's latest intent); only outputs/results/outputsSig are adopted, and
// the staleness signature still guards against reusing outputs whose config
// or inputs no longer match.
export async function mergePersistedOutputs(graph: Graph, workflowId: string): Promise<void> {
  try {
    const wf = await prisma.workflow.findUnique({ where: { id: workflowId }, select: { graph: true } });
    const dbNodes = (wf?.graph as { nodes?: GraphNode[] } | null)?.nodes;
    if (!Array.isArray(dbNodes)) return;
    const byId = new Map(dbNodes.map((n) => [n.id, n]));
    let adopted = 0;
    for (const n of graph.nodes) {
      const db = byId.get(n.id);
      if (!db || !db.outputs || Object.keys(db.outputs).length === 0) continue;
      n.outputs = db.outputs;
      n.results = db.results;
      n.outputsSig = db.outputsSig;
      adopted++;
    }
    if (adopted > 0) console.log(`[executeRun] merged persisted outputs for ${adopted} nodes from DB graph`);
  } catch (err) {
    console.warn("[executeRun] mergePersistedOutputs failed (non-fatal):", err);
  }
}

export async function executeRun(
  runId: string,
  graph: Graph,
  workflow: { id: string; projectId: string; project: { brandId: string | null } },
  scopeNodeId?: string | string[],
) {
  const scopeIds = Array.isArray(scopeNodeId) ? scopeNodeId : scopeNodeId ? [scopeNodeId] : [];
  console.log(`[executeRun] ${runId} starting; scope=${scopeIds.join("+") || "all"}`);
  if (scopeIds.length) await mergePersistedOutputs(graph, workflow.id);
  const scope = scopeIds.length
    ? new Set(scopeIds.flatMap((id) => [...ancestorsOf(graph, id)]))
    : undefined;
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
    { runId, scope, scopeNodeIds: scopeIds.length ? scopeIds : undefined },
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
export async function executeRunById(runId: string, graph: Graph, workflowId: string, scopeNodeId?: string | string[]) {
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
