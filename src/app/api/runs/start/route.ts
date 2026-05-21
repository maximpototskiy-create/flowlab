import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { executeGraph, ancestorsOf } from "@/lib/engine/executor";
import type { Graph } from "@/lib/canvas/types";

export const runtime = "nodejs";
// Vercel Hobby plan max is 300s. Pro is 800s. Long video gen on Hobby may hit limits —
// run nodes individually rather than Run All.
export const maxDuration = 300;

export async function POST(req: Request) {
  try {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const body = (await req.json()) as {
      workflowId: string;
      graph: Graph;
      scope?: string;
    };

    if (!body.workflowId || !body.graph) {
      return NextResponse.json({ error: "Missing workflowId or graph" }, { status: 400 });
    }
    if (!Array.isArray(body.graph.nodes) || body.graph.nodes.length === 0) {
      return NextResponse.json({ error: "Empty graph" }, { status: 400 });
    }

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

    await prisma.workflow.update({
      where: { id: workflow.id },
      data: { graph: body.graph as never },
    });

    // Fire-and-forget execution. Client will poll /api/runs/[id] for status.
    void executeRun(run.id, body.graph, workflow, body.scope).catch((err) => {
      console.error(`[runs/start] executeRun ${run.id} crashed:`, err);
    });

    return NextResponse.json({ runId: run.id });
  } catch (err) {
    console.error("[runs/start] handler failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Run failed to start" },
      { status: 500 },
    );
  }
}

async function executeRun(
  runId: string,
  graph: Graph,
  workflow: { id: string; projectId: string; project: { brandId: string | null } },
  scopeNodeId?: string,
) {
  try {
    const scope = scopeNodeId ? ancestorsOf(graph, scopeNodeId) : undefined;
    const result = await executeGraph(
      graph,
      {
        brandId: workflow.project.brandId,
        projectId: workflow.projectId,
        workflowId: workflow.id,
      },
      { runId, scope, scopeNodeId },
    );

    const current = await prisma.run.findUnique({ where: { id: runId }, select: { status: true } });
    if (current?.status === "cancelled") return;

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
    console.error(`[executeRun] ${runId} failed:`, err);
    await prisma.run
      .update({
        where: { id: runId },
        data: {
          status: "error",
          finishedAt: new Date(),
          errorMessage: err instanceof Error ? err.message : "Unknown error",
        },
      })
      .catch(() => {});
  }
}
