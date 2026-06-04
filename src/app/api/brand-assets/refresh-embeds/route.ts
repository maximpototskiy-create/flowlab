// POST /api/brand-assets/refresh-embeds { brandId }
// Checks a small batch of "processing" video/audio embed tasks and, when ready,
// stores their clip segments. Kept separate from the asset list (GET) so the
// list stays instant and the DB connection pool never starves.
import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getEmbedTaskStatus } from "@/lib/twelvelabs/embed";
import { insertEmbedding } from "@/lib/semantic";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_PER_CALL = 6; // bound external calls + DB writes per request

type Row = { id: string; brandId: string; url: string; kind: string; category: string; embedTaskId: string | null };

export async function POST(req: Request): Promise<NextResponse> {
  await requireUser();
  let body: { brandId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }
  const { brandId } = body;
  if (!brandId) return NextResponse.json({ error: "brandId required" }, { status: 400 });

  const pending = (await prisma.brandAsset.findMany({
    where: { brandId, kind: { in: ["video", "audio"] }, embedStatus: "processing", embedTaskId: { not: null } },
    take: MAX_PER_CALL,
    orderBy: { createdAt: "asc" },
  })) as Row[];

  let ready = 0;
  let failed = 0;
  // Sequential — avoids opening many pooled connections at once.
  for (const a of pending) {
    try {
      const { status, segments, error } = await getEmbedTaskStatus(a.embedTaskId as string);
      if (status === "failed") {
        await prisma.brandAsset.update({
          where: { id: a.id },
          data: { embedStatus: "failed", embedError: (error ?? "embed task failed").slice(0, 500) },
        });
        failed++;
        continue;
      }
      if (status !== "ready") continue; // still processing
      for (const seg of segments) {
        if (seg.embedding?.length) {
          await insertEmbedding({
            assetId: a.id,
            brandId: a.brandId,
            modality: a.kind === "audio" ? "audio" : "video",
            category: a.category,
            url: a.url,
            embedding: seg.embedding,
            startSec: seg.startSec,
            endSec: seg.endSec,
          });
        }
      }
      await prisma.brandAsset.update({ where: { id: a.id }, data: { embedStatus: "ready", embedError: null } });
      ready++;
    } catch {
      /* leave processing; retried next call */
    }
  }

  const remaining = await prisma.brandAsset.count({
    where: { brandId, kind: { in: ["video", "audio"] }, embedStatus: "processing" },
  });
  return NextResponse.json({ ok: true, ready, failed, remaining });
}
