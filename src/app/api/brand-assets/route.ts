// Brand assets API — curated brand building blocks with categories.
// On create we also embed the asset into our semantic index (pgvector):
//   • images  → embedded synchronously (instant, Marengo image embedding)
//   • videos  → async Marengo embed task; clip segments stored when ready
//   • audio   → stored only (not embedded for now)
//   GET    /api/brand-assets?brandId=…        → list (refreshes pending video embeds)
//   POST   /api/brand-assets                  → { brandId, url, kind, category, label? }
//   DELETE /api/brand-assets?id=…             → remove one (+ its embeddings)
import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { embedImage, embedVideo } from "@/lib/twelvelabs/embed";
import { insertEmbedding, deleteEmbeddingsForAsset } from "@/lib/semantic";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const CATEGORIES = ["logo", "ui", "store", "graphic", "overlay", "music", "sound", "reference", "hook", "body", "packshot", "other"];
const KINDS = ["image", "video", "audio"];

export async function GET(req: Request): Promise<NextResponse> {
  await requireUser();
  const { searchParams } = new URL(req.url);
  const brandId = searchParams.get("brandId");
  if (!brandId) return NextResponse.json({ assets: [] });

  // Fast path: just return the list. Embedding-status refresh for "processing"
  // videos/audio is done by a separate, rate-limited endpoint
  // (/api/brand-assets/refresh-embeds) so this never blocks on TwelveLabs and
  // never starves the DB connection pool.
  const assets = await prisma.brandAsset.findMany({
    where: { brandId },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json({ assets });
}

export async function POST(req: Request): Promise<NextResponse> {
  await requireUser();
  let body: { brandId?: string; url?: string; kind?: string; category?: string; label?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }
  const { brandId, url, kind, category, label } = body;
  if (!brandId || !url || !kind || !category) {
    return NextResponse.json({ error: "brandId, url, kind, category required" }, { status: 400 });
  }
  if (!KINDS.includes(kind)) return NextResponse.json({ error: "bad kind" }, { status: 400 });
  if (!CATEGORIES.includes(category)) return NextResponse.json({ error: "bad category" }, { status: 400 });

  const asset = await prisma.brandAsset.create({
    data: { brandId, url, kind, category, label: label || null },
  });

  // Embed into the semantic index. Best-effort: upload always succeeds.
  if (kind === "image") {
    try {
      const vec = await embedImage(url);
      await insertEmbedding({ assetId: asset.id, brandId, modality: "image", category, url, embedding: vec });
      await prisma.brandAsset.update({ where: { id: asset.id }, data: { embedStatus: "ready" } });
      return NextResponse.json({ asset: { ...asset, embedStatus: "ready" } });
    } catch (err) {
      console.error("[brand-assets] image embed failed:", err);
      await prisma.brandAsset.update({ where: { id: asset.id }, data: { embedStatus: "failed" } }).catch(() => {});
      return NextResponse.json({ asset: { ...asset, embedStatus: "failed" }, embedWarning: "Embedding failed (asset saved)." });
    }
  }

  if (kind === "video") {
    try {
      const { taskId } = await embedVideo(url); // async; segments fetched later via GET
      await prisma.brandAsset.update({ where: { id: asset.id }, data: { embedTaskId: taskId, embedStatus: "processing" } });
      return NextResponse.json({ asset: { ...asset, embedTaskId: taskId, embedStatus: "processing" } });
    } catch (err) {
      console.error("[brand-assets] video embed task failed:", err);
      await prisma.brandAsset.update({ where: { id: asset.id }, data: { embedStatus: "failed" } }).catch(() => {});
      return NextResponse.json({ asset: { ...asset, embedStatus: "failed" }, embedWarning: "Video embedding failed (asset saved)." });
    }
  }

  return NextResponse.json({ asset });
}

export async function DELETE(req: Request): Promise<NextResponse> {
  await requireUser();
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  await deleteEmbeddingsForAsset(id).catch(() => {});
  await prisma.brandAsset.delete({ where: { id } }).catch(() => {});
  return NextResponse.json({ ok: true });
}
