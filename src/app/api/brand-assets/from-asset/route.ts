// POST /api/brand-assets/from-asset { assetId, brandId, category }
// Saves a generated/library Asset into a brand's curated assets and embeds it
// (same pipeline as manual upload / Drive import). Dedupes by url per brand.
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

export async function POST(req: Request): Promise<NextResponse> {
  await requireUser();
  let body: { assetId?: string; brandId?: string; category?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }
  const { assetId, brandId, category } = body;
  if (!assetId || !brandId || !category) return NextResponse.json({ error: "assetId, brandId, category required" }, { status: 400 });
  if (!CATEGORIES.includes(category)) return NextResponse.json({ error: "bad category" }, { status: 400 });

  const asset = await prisma.asset.findUnique({ where: { id: assetId } });
  if (!asset) return NextResponse.json({ error: "asset not found" }, { status: 404 });
  const kind = asset.kind === "text" ? "image" : asset.kind; // text isn't embeddable as media
  if (!["image", "video", "audio"].includes(kind)) return NextResponse.json({ error: "unsupported asset kind" }, { status: 400 });

  // Dedupe: same url already saved to this brand?
  const existing = await prisma.brandAsset.findFirst({ where: { brandId, url: asset.cdnUrl } });
  if (existing) return NextResponse.json({ asset: existing, already: true });

  const created = await prisma.brandAsset.create({
    data: {
      brandId,
      url: asset.cdnUrl,
      kind,
      category,
      label: asset.prompt?.slice(0, 200) || asset.model || "generated",
    },
  });

  try {
    if (kind === "image") {
      const embedUrl = await ensureEmbeddableImage(asset.cdnUrl, `brands/${brandId}/jpeg/${created.id}.jpg`);
      const vec = await embedImage(embedUrl);
      await insertEmbedding({ assetId: created.id, brandId, modality: "image", category, url: asset.cdnUrl, embedding: vec });
      await prisma.brandAsset.update({ where: { id: created.id }, data: { embedStatus: "ready" } });
    } else if (kind === "video") {
      const { taskId } = await embedVideoSmart(asset.cdnUrl, `brands/${brandId}/padded/${created.id}.mp4`);
      await prisma.brandAsset.update({ where: { id: created.id }, data: { embedTaskId: taskId, embedStatus: "processing" } });
    } else {
      const { taskId } = await embedAudio(asset.cdnUrl);
      await prisma.brandAsset.update({ where: { id: created.id }, data: { embedTaskId: taskId, embedStatus: "processing" } });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await prisma.brandAsset.update({ where: { id: created.id }, data: { embedStatus: "failed", embedError: msg.slice(0, 500) } }).catch(() => {});
    return NextResponse.json({ asset: { ...created, embedStatus: "failed" }, embedWarning: msg });
  }

  return NextResponse.json({ asset: created });
}
