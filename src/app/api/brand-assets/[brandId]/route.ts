import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/brand-assets/[brandId]
 *
 * Returns this brand's assets from brand_assets (the single source of truth).
 * Used by the Brand Assets canvas node (BrandAssetsPicker), which lets the
 * user filter by category and pick which assets flow downstream.
 *
 * Response:
 *   { urls: string[],                 // image URLs (back-compat with old node)
 *     assets: { url, kind, category, label }[] }
 */
export async function GET(
  _req: Request,
  context: { params: Promise<{ brandId: string }> },
): Promise<NextResponse> {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { brandId } = await context.params;
  if (!brandId) return NextResponse.json({ urls: [], assets: [] });

  try {
    const rows = (await prisma.brandAsset.findMany({
      where: { brandId },
      orderBy: { createdAt: "desc" },
      select: { url: true, kind: true, category: true, label: true },
    })) as { url: string; kind: string; category: string; label: string | null }[];

    const assets = rows.filter((r) => r.url?.startsWith("http"));
    const urls = assets.filter((a) => a.kind === "image").map((a) => a.url);
    return NextResponse.json({ urls, assets });
  } catch (err) {
    console.error("[api/brand-assets/[brandId]] GET failed:", err);
    return NextResponse.json({ urls: [], assets: [], error: "fetch failed" });
  }
}
