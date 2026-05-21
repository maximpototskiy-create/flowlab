// POST /api/runs/[id]/cancel — mark a run as cancelled.
// The executor checks this status between steps and bails out gracefully.

import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const user = await requireUser();

  const run = await prisma.run.findUnique({
    where: { id },
    include: { workflow: { include: { project: { include: { brand: true } } } } },
  });
  if (!run) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Only allow the triggering user (or anyone with brand access) to cancel.
  if (run.triggeredBy !== user.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Only running/pending runs can be cancelled
  if (run.status !== "running" && run.status !== "pending") {
    return NextResponse.json({ ok: true, alreadyFinished: true });
  }

  await prisma.run.update({
    where: { id },
    data: {
      status: "cancelled",
      finishedAt: new Date(),
    },
  });

  // Also mark any in-flight steps as cancelled
  await prisma.runStep.updateMany({
    where: { runId: id, status: { in: ["pending", "running"] } },
    data: { status: "cancelled", finishedAt: new Date() },
  });

  return NextResponse.json({ ok: true });
}
