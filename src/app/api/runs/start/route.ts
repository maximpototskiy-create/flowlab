import { NextResponse } from "next/server";
import { after } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { executeGraph, ancestorsOf } from "@/lib/engine/executor";
import { buildBrandContext, getBrandUiScreenshots } from "@/lib/engine/brandContext";
import type { Graph } from "@/lib/canvas/types";

export const runtime = "nodejs";
// Vercel Hobby plan max is 300s. With after(), the executor runs in background
// up to this limit — perfect for typical AI node runs (5-60s each).
export const maxDuration = 300;

export async function POST(req: Request) {
  try {
    console.log("[runs/start] handler invoked");
    const user = await getCurrentUser();
    if (!user) {
      console.warn("[runs/start] no user");
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

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
    console.log(`[runs/start] created run ${run.id}, scope=${body.scope ?? 'all'}, nodes=${body.graph.nodes.length}`);

    await prisma.workflow.update({
      where: { id: workflow.id },
      data: { graph: body.graph as never },
    });

    // CRITICAL: use after() so Vercel keeps the function alive past the response.
    // Without this, Vercel kills the lambda the moment we return NextResponse.json(),
    // and the executor never gets to call fal.ai.
    after(async () => {
      console.log(`[runs/start] after() started for run ${run.id}`);
      try {
        await executeRun(run.id, body.graph, workflow, body.scope);
        console.log(`[runs/start] after() finished for run ${run.id}`);
      } catch (err) {
        console.error(`[runs/start] after() crashed for run ${run.id}:`, err);
      }
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
    console.log(`[executeRun] ${runId} starting; scope=${scopeNodeId ?? 'all'}`);
    const scope = scopeNodeId ? ancestorsOf(graph, scopeNodeId) : undefined;
    // Load brand context once per run — applied to every LLM-driven node via
    // ctx.brandVoice. Cheap query (one DB read), and the result is a static
    // string used many times across the graph, so this is essentially free.
    const brandVoice = await buildBrandContext(workflow.project.brandId);
    // Also load UI screenshots — these get auto-attached as reference images
    // to imageGen nodes (Nano Banana sees the actual app UI) AND as vision
    // inputs to LLM nodes. Without this, the brand had screenshots in DB
    // but no node ever consumed them.
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
  } catch (err) {
    console.error(`[executeRun] ${runId} crashed:`, err);
    await prisma.run
      .update({
        where: { id: runId },
        data: {
          status: "error",
          finishedAt: new Date(),
          errorMessage: err instanceof Error ? err.message : "Unknown error",
        },
      })
      .catch((updateErr: unknown) => console.error(`[executeRun] ${runId} failed to mark error:`, updateErr));
  }
}
