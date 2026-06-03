// POST /api/brand-assets/reembed { brandId }
// Re-embeds brand assets that have no embedding yet or previously failed
// (images sync, videos async). Useful after fixing the embed pipeline.
import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { embedImage, embedVideo } from "@/lib/twelvelabs/embed";
import { insertEmbedding, deleteEmbeddingsForAsset } from "@/lib/semantic";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

type AssetRow = { id: string; brandId: string; url: string; kind: string; category: string; embedStatus: string | null };

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

  // Targets: images/videos that aren't ready (failed or never embedded).
  const targets = (await prisma.brandAsset.findMany({
    where: {
      brandId,
      kind: { in: ["image", "video"] },
      OR: [{ embedStatus: null }, { embedStatus: "failed" }],
    },
  })) as AssetRow[];

  let images = 0;
  let videos = 0;
  let failed = 0;

  for (const a of targets) {
    try {
      await deleteEmbeddingsForAsset(a.id).catch(() => {});
      if (a.kind === "image") {
        const vec = await embedImage(a.url);
        await insertEmbedding({ assetId: a.id, brandId, modality: "image", category: a.category, url: a.url, embedding: vec });
        await prisma.brandAsset.update({ where: { id: a.id }, data: { embedStatus: "ready", embedTaskId: null } });
        images++;
      } else {
        const { taskId } = await embedVideo(a.url);
        await prisma.brandAsset.update({ where: { id: a.id }, data: { embedTaskId: taskId, embedStatus: "processing" } });
        videos++;
      }
    } catch (err) {
      console.error("[reembed] failed for", a.id, err);
      await prisma.brandAsset.update({ where: { id: a.id }, data: { embedStatus: "failed" } }).catch(() => {});
      failed++;
    }
  }

  return NextResponse.json({ ok: true, images, videos, failed, total: targets.length });
}
