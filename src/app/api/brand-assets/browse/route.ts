// GET /api/brand-assets/browse?category=&modality=&brandId=&limit=
// Lists curated brand assets WITHOUT a search query — for browsing by category.
// Scoped to the current user's brands. Newest first.
import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<NextResponse> {
  const user = await requireUser();
  const { searchParams } = new URL(req.url);
  const category = searchParams.get("category");
  const modality = searchParams.get("modality"); // image | video | audio
  const brandId = searchParams.get("brandId");
  const limit = Math.min(Number(searchParams.get("limit") ?? 60), 200);

  // If a brandId is given (project/canvas context), trust it directly — same as
  // the Brand Assets manager. Only the global /library (no brandId) scopes to
  // the current user's brands.
  const where: Record<string, unknown> = {};
  if (brandId) {
    where.brandId = brandId;
  } else {
    where.brand = { createdBy: user.id, archivedAt: null };
  }
  if (category && category !== "all") where.category = category;
  if (modality && modality !== "all") where.kind = modality;

  const rows = await prisma.brandAsset.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: limit,
    select: { id: true, url: true, kind: true, category: true, label: true, embedStatus: true, brandId: true, createdAt: true },
  });

  return NextResponse.json({ assets: rows });
}
