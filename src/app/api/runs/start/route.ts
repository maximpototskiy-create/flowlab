import { NextResponse } from "next/server";
import { after } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { executeRun } from "@/lib/engine/runWorkflow";
import { inngest, EVENTS } from "@/lib/inngest/client";
import type { Graph } from "@/lib/canvas/types";

export const runtime = "nodejs";
// Vercel Pro + Fluid Compute: up to 800s. Matters for the after() fallback
// path, which executes the whole run inline when Inngest enqueue fails.
export const maxDuration = 800;

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

    // Enqueue the run on Inngest (queue with concurrency control + retries)
    // instead of running it inline via after(). If enqueue fails for any reason
    // (e.g. Inngest not configured), fall back to the old after() path so the
    // app keeps working.
    let queued = false;
    try {
      await inngest.send({
        name: EVENTS.workflowRunRequested,
        data: { runId: run.id, graph: body.graph, workflowId: workflow.id, scopeNodeId: body.scope, userId: user.id },
      });
      queued = true;
      console.log(`[runs/start] queued run ${run.id} on Inngest`);
    } catch (err) {
      console.error(`[runs/start] Inngest enqueue failed, falling back to after():`, err);
    }

    if (!queued) {
      after(async () => {
        console.log(`[runs/start] after() fallback started for run ${run.id}`);
        try {
          await executeRun(run.id, body.graph, workflow, body.scope);
        } catch (err) {
          console.error(`[runs/start] after() crashed for run ${run.id}:`, err);
        }
      });
    }

    return NextResponse.json({ runId: run.id });
  } catch (err) {
    console.error("[runs/start] handler failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Run failed to start" },
      { status: 500 },
    );
  }
}
