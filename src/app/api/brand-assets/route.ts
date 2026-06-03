// Brand assets API — curated brand building blocks with categories.
//   GET    /api/brand-assets?brandId=…        → list
//   POST   /api/brand-assets                  → { brandId, url, kind, category, label? }
//   DELETE /api/brand-assets?id=…             → remove one
import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

const CATEGORIES = ["logo", "ui", "graphic", "overlay", "music", "sound", "reference", "hook", "body", "packshot", "other"];
const KINDS = ["image", "video", "audio"];

export async function GET(req: Request): Promise<NextResponse> {
  await requireUser();
  const { searchParams } = new URL(req.url);
  const brandId = searchParams.get("brandId");
  if (!brandId) return NextResponse.json({ assets: [] });
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
  return NextResponse.json({ asset });
}

export async function DELETE(req: Request): Promise<NextResponse> {
  await requireUser();
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  await prisma.brandAsset.delete({ where: { id } }).catch(() => {});
  return NextResponse.json({ ok: true });
}
