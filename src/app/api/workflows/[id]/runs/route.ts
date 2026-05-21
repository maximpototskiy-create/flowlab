import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  await requireUser();
  const { id } = await params;
  const runs = await prisma.run.findMany({
    where: { workflowId: id },
    orderBy: { startedAt: "desc" },
    take: 50,
    include: {
      trigger: { select: { name: true, email: true } },
      _count: { select: { steps: true } },
    },
  });
  return NextResponse.json({
    runs: runs.map((r: typeof runs[number]) => ({
      id: r.id,
      status: r.status,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      totalCostUsd: r.totalCostUsd,
      errorMessage: r.errorMessage,
      stepCount: r._count.steps,
      trigger: r.trigger,
    })),
  });
}
