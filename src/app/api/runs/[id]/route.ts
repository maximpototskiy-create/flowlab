import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    // Auth — don't use requireUser() in API routes (redirect() inside polling causes 500/ERR_ABORTED)
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;
    if (!id) {
      return NextResponse.json({ error: "Missing id" }, { status: 400 });
    }

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

    // Carefully serialize — convert any BigInt / Date / nullables to plain JSON-safe values.
    const payload = {
      id: run.id,
      status: run.status,
      startedAt: run.startedAt?.toISOString() ?? null,
      finishedAt: run.finishedAt?.toISOString() ?? null,
      totalCostUsd: Number(run.totalCostUsd ?? 0),
      errorMessage: run.errorMessage ?? null,
      steps: (run.steps ?? []).map((s: (typeof run.steps)[number]) => ({
        id: s.id,
        nodeId: s.nodeId,
        nodeType: s.nodeType,
        model: s.model ?? null,
        status: s.status,
        startedAt: s.startedAt?.toISOString() ?? null,
        finishedAt: s.finishedAt?.toISOString() ?? null,
        costUsd: Number(s.costUsd ?? 0),
        outputData: s.outputData ?? null,
        errorMessage: s.errorMessage ?? null,
        assets: (s.assets ?? []).map((a: (typeof s.assets)[number]) => ({
          id: a.id,
          cdnUrl: a.cdnUrl,
          kind: a.kind,
          mimeType: a.mimeType ?? null,
        })),
      })),
    };

    return NextResponse.json(payload);
  } catch (err) {
    // Polled while a run is in flight — must not 500 on a transient DB hiccup
    // (e.g. P2024 pool timeout under load). Return a soft "transient" 200 so
    // the client keeps the last state and retries next tick.
    console.error("[api/runs/[id]] GET failed (transient):", err);
    return NextResponse.json({ transient: true }, { status: 200 });
  }
}
