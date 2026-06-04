// POST /api/brand-assets/from-asset { url, kind?, brandId, category, label? }
// Saves any media URL (a node result, a generated asset, etc.) into a brand's
// curated assets and embeds it (same pipeline as upload / Drive import).
// Dedupes by url per brand.
import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { embedImage, embedAudio } from "@/lib/twelvelabs/embed";
import { embedVideoSmart } from "@/lib/video";
import { ensureEmbeddableImage } from "@/lib/image";
import { insertEmbedding } from "@/lib/semantic";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const CATEGORIES = ["logo", "ui", "store", "graphic", "overlay", "music", "sound", "reference", "hook", "body", "packshot", "other"];

function kindFromUrl(url: string): string {
  const u = url.split("?")[0].toLowerCase();
  if (/\.(mp4|mov|webm|m4v)$/.test(u)) return "video";
  if (/\.(mp3|wav|m4a|aac|ogg)$/.test(u)) return "audio";
  return "image";
}

export async function POST(req: Request): Promise<NextResponse> {
  await requireUser();
  let body: { url?: string; kind?: string; brandId?: string; category?: string; label?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }
  const { url, brandId, category, label } = body;
  if (!url || !brandId || !category) return NextResponse.json({ error: "url, brandId, category required" }, { status: 400 });
  if (!CATEGORIES.includes(category)) return NextResponse.json({ error: "bad category" }, { status: 400 });

  let kind = body.kind && ["image", "video", "audio"].includes(body.kind) ? body.kind : kindFromUrl(url);
  if (kind === "text") kind = "image";

  const existing = await prisma.brandAsset.findFirst({ where: { brandId, url } });
  if (existing) return NextResponse.json({ asset: existing, already: true });

  const created = await prisma.brandAsset.create({
    data: { brandId, url, kind, category, label: (label || "saved").slice(0, 200) },
  });

  try {
    if (kind === "image") {
      const embedUrl = await ensureEmbeddableImage(url, `brands/${brandId}/jpeg/${created.id}.jpg`);
      const vec = await embedImage(embedUrl);
      await insertEmbedding({ assetId: created.id, brandId, modality: "image", category, url, embedding: vec });
      await prisma.brandAsset.update({ where: { id: created.id }, data: { embedStatus: "ready" } });
    } else if (kind === "video") {
      const { taskId } = await embedVideoSmart(url, `brands/${brandId}/padded/${created.id}.mp4`);
      await prisma.brandAsset.update({ where: { id: created.id }, data: { embedTaskId: taskId, embedStatus: "processing" } });
    } else {
      const { taskId } = await embedAudio(url);
      await prisma.brandAsset.update({ where: { id: created.id }, data: { embedTaskId: taskId, embedStatus: "processing" } });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await prisma.brandAsset.update({ where: { id: created.id }, data: { embedStatus: "failed", embedError: msg.slice(0, 500) } }).catch(() => {});
    return NextResponse.json({ asset: { ...created, embedStatus: "failed" }, embedWarning: msg });
  }

  return NextResponse.json({ asset: created });
}
