// GET /api/brand-assets/browse?category=&modality=&brandId=&limit=
// Lists curated brand assets WITHOUT a search query — for browsing by category.
// Scoped to the current user's brands. Newest first.
import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<NextResponse> {
  await requireUser();
  const { searchParams } = new URL(req.url);
  const category = searchParams.get("category");
  const modality = searchParams.get("modality"); // image | video | audio
  const brandId = searchParams.get("brandId");
  const sort = searchParams.get("sort") ?? "newest"; // newest | oldest | type
  const limit = Math.min(Number(searchParams.get("limit") ?? 60), 200);

  // Scope: a brandId narrows to that brand; otherwise list across brands
  // (same visibility model as the /assets gallery).
  const where: Record<string, unknown> = {};
  if (brandId) where.brandId = brandId;
  if (category && category !== "all") where.category = category;
  if (modality && modality !== "all") where.kind = modality;

  const orderBy =
    sort === "oldest"
      ? { createdAt: "asc" as const }
      : sort === "type"
        ? [{ kind: "asc" as const }, { createdAt: "desc" as const }]
        : { createdAt: "desc" as const };

  const rows = await prisma.brandAsset.findMany({
    where,
    orderBy,
    take: limit,
    select: { id: true, url: true, kind: true, category: true, label: true, embedStatus: true, brandId: true, createdAt: true },
  });

  return NextResponse.json({ assets: rows });
}
