import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  await requireUser();
  const { id } = await params;
  const run = await prisma.run.findUnique({
    where: { id },
    include: {
      steps: {
        orderBy: { startedAt: "asc" },
        include: {
          assets: {
            select: { id: true, cdnUrl: true, kind: true, mimeType: true },
          },
        },
      },
    },
  });
  if (!run) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json({
    id: run.id,
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    totalCostUsd: run.totalCostUsd,
    errorMessage: run.errorMessage,
    steps: run.steps.map((s: typeof run.steps[number]) => ({
      id: s.id,
      nodeId: s.nodeId,
      nodeType: s.nodeType,
      model: s.model,
      status: s.status,
      startedAt: s.startedAt,
      finishedAt: s.finishedAt,
      costUsd: s.costUsd,
      outputData: s.outputData,
      errorMessage: s.errorMessage,
      assets: s.assets,
    })),
  });
}
