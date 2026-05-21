import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { executeGraph, ancestorsOf } from "@/lib/engine/executor";
import type { Graph } from "@/lib/canvas/types";

export const runtime = "nodejs";
export const maxDuration = 800; // up to ~13 minutes for video generation

export async function POST(req: Request) {
  const user = await requireUser();
  const body = (await req.json()) as {
    workflowId: string;
    graph: Graph;
    scope?: string; // single node id to run (subgraph) or undefined for full
  };

  const workflow = await prisma.workflow.findUnique({
    where: { id: body.workflowId },
    include: { project: { include: { brand: true } } },
  });
  if (!workflow) return NextResponse.json({ error: "Workflow not found" }, { status: 404 });

  const run = await prisma.run.create({
    data: {
      workflowId: workflow.id,
      triggeredBy: user.id,
      status: "running",
      graphSnapshot: body.graph as never,
    },
  });

  // Persist graph from the request to the workflow (autosave)
  await prisma.workflow.update({
    where: { id: workflow.id },
    data: { graph: body.graph as never },
  });

  // Execute asynchronously — fire-and-forget, the client will poll
  void executeRun(run.id, body.graph, workflow, body.scope);

  return NextResponse.json({ runId: run.id });
}

async function executeRun(
  runId: string,
  graph: Graph,
  workflow: { id: string; projectId: string; project: { brandId: string | null } },
  scopeNodeId?: string,
) {
  try {
    const scope = scopeNodeId ? ancestorsOf(graph, scopeNodeId) : undefined;
    const result = await executeGraph(graph, {
      brandId: workflow.project.brandId,
      projectId: workflow.projectId,
      workflowId: workflow.id,
    }, { runId, scope });

    await prisma.run.update({
      where: { id: runId },
      data: {
        status: result.errors.size > 0 ? "error" : "done",
        finishedAt: new Date(),
        totalCostUsd: result.totalCost,
        errorMessage: result.errors.size > 0 ? [...result.errors.values()][0] : null,
      },
    });
  } catch (err) {
    await prisma.run.update({
      where: { id: runId },
      data: {
        status: "error",
        finishedAt: new Date(),
        errorMessage: err instanceof Error ? err.message : "Unknown error",
      },
    });
  }
}
