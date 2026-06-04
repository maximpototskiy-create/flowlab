// POST /api/brand-assets/reembed { brandId }
// Re-embeds brand assets that have no embedding yet or previously failed
// (images sync, videos async). Useful after fixing the embed pipeline.
import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { embedImage, embedAudio } from "@/lib/twelvelabs/embed";
import { embedVideoSmart } from "@/lib/video";
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
      kind: { in: ["image", "video", "audio"] },
      OR: [{ embedStatus: null }, { embedStatus: "failed" }],
    },
  })) as AssetRow[];

  let images = 0;
  let videos = 0;
  let failed = 0;
  const errors: string[] = [];
  const videoErrors: string[] = [];

  for (const a of targets) {
    try {
      await deleteEmbeddingsForAsset(a.id).catch(() => {});
      if (a.kind === "image") {
        const vec = await embedImage(a.url);
        await insertEmbedding({ assetId: a.id, brandId, modality: "image", category: a.category, url: a.url, embedding: vec });
        await prisma.brandAsset.update({ where: { id: a.id }, data: { embedStatus: "ready", embedTaskId: null, embedError: null } });
        images++;
      } else if (a.kind === "video") {
        const { taskId } = await embedVideoSmart(a.url, `brands/${brandId}/padded/${a.id}.mp4`);
        await prisma.brandAsset.update({ where: { id: a.id }, data: { embedTaskId: taskId, embedStatus: "processing", embedError: null } });
        videos++;
      } else {
        const { taskId } = await embedAudio(a.url);
        await prisma.brandAsset.update({ where: { id: a.id }, data: { embedTaskId: taskId, embedStatus: "processing", embedError: null } });
        videos++;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[reembed] failed for", a.id, msg);
      const label = (a as { label?: string | null }).label ?? a.id;
      if (errors.length < 3) errors.push(`${label}: ${msg}`);
      if ((a.kind === "video" || a.kind === "audio") && videoErrors.length < 3) videoErrors.push(`${label}: ${msg}`);
      await prisma.brandAsset.update({ where: { id: a.id }, data: { embedStatus: "failed", embedError: msg.slice(0, 500) } }).catch(() => {});
      failed++;
    }
  }

  return NextResponse.json({ ok: true, images, videos, failed, total: targets.length, errors, videoErrors });
}
