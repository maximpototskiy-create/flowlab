// src/app/api/runs/active/route.ts
// Returns all currently-running Runs triggered by the current user, across
// every workflow. Used by the ActiveRunsIndicator badge in TopNav and by
// the per-workflow toolbar so users can see at-a-glance what's generating
// even when they're on a different page.
//
// Designed to be cheap and pollable (~5s). One SELECT with a few joins.

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
// Don't cache — status changes by the second.
export const dynamic = "force-dynamic";

// Short per-user in-memory cache (per lambda instance). The badge is polled
// frequently and by multiple tabs; without this each poll hits the DB. 3s is
// fresh enough for a status badge and slashes connection-pool pressure.
const RESULT_TTL_MS = 3000;
const resultCache = new Map<string, { at: number; payload: unknown }>();

export async function GET() {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const cached = resultCache.get(user.id);
    if (cached && Date.now() - cached.at < RESULT_TTL_MS) {
      return NextResponse.json(cached.payload);
    }

    // Pull every run still in flight for this user. The set is naturally
    // tiny (users rarely have >10 simultaneous generations), so no pagination.
    const activeRuns = await prisma.run.findMany({
      where: {
        triggeredBy: user.id,
        status: { in: ["pending", "running"] },
      },
      orderBy: { startedAt: "desc" },
      include: {
        workflow: {
          select: {
            id: true,
            name: true,
            project: {
              select: {
                id: true,
                name: true,
                brand: { select: { slug: true } },
              },
            },
          },
        },
        steps: {
          orderBy: { startedAt: "asc" },
          select: {
            nodeId: true,
            nodeType: true,
            status: true,
            startedAt: true,
            finishedAt: true,
          },
        },
      },
    });

    // Hygiene: any run that's been "running" >10 minutes is almost certainly
    // dead (Vercel Hobby maxDuration is 300s, so anything past that means
    // the lambda was killed mid-execution and our run row was orphaned).
    // We don't auto-mark it as error here (that's the executor's job) — we
    // just hide it from the badge so it doesn't show a fake spinner forever.
    const TEN_MINUTES_MS = 10 * 60 * 1000;
    const now = Date.now();
    type RunRow = (typeof activeRuns)[number];
    type StepRow = RunRow["steps"][number];
    const fresh = activeRuns.filter(
      (r: RunRow) => now - r.startedAt.getTime() < TEN_MINUTES_MS,
    );

    const payload = {
      count: fresh.length,
      runs: fresh.map((r: RunRow) => {
        const total = r.steps.length;
        const done = r.steps.filter((s: StepRow) => s.status === "done").length;
        const running = r.steps.filter((s: StepRow) => s.status === "running").length;
        const errored = r.steps.filter((s: StepRow) => s.status === "error").length;
        return {
          runId: r.id,
          workflowId: r.workflowId,
          workflowName: r.workflow?.name ?? "(unnamed)",
          projectId: r.workflow?.project?.id ?? null,
          projectName: r.workflow?.project?.name ?? null,
          brandSlug: r.workflow?.project?.brand?.slug ?? null,
          status: r.status,
          startedAt: r.startedAt.toISOString(),
          progress: { total, done, running, errored },
          // The set of node IDs that are currently running — Canvas uses
          // this to paint live spinners on the right nodes when you open
          // a workflow that already has a run in flight.
          activeNodeIds: r.steps
            .filter((s: StepRow) => s.status === "running" || s.status === "pending")
            .map((s: StepRow) => s.nodeId),
        };
      }),
    };

    resultCache.set(user.id, { at: Date.now(), payload });
    return NextResponse.json(payload);
  } catch (err) {
    // This endpoint is polled every few seconds purely to drive a status
    // badge. It must NEVER take the page down. On any DB hiccup (e.g. P2024
    // connection-pool timeout under load) return an empty, healthy 200 so the
    // client just shows "no active runs" this tick and retries next poll —
    // instead of a 500 that surfaces as a broken page.
    console.error("[api/runs/active] GET failed (returning empty):", err);
    return NextResponse.json({ count: 0, runs: [], degraded: true });
  }
}
