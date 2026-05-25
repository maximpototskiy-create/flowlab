import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getBrandUiScreenshots } from "@/lib/engine/brandContext";

export const runtime = "nodejs";

/**
 * GET /api/brand-assets/[brandId]
 *
 * Returns the UI screenshot URLs saved on this brand's BrandKit.
 * Used by the Brand Assets canvas node (BrandAssetsPicker) to render
 * thumbnails the user can check/uncheck for inclusion in the next run.
 *
 * Returns an empty array if no kit, no brand, or no screenshots — the
 * client treats all of those as "nothing to show, render empty state".
 */
export async function GET(
  _req: Request,
  context: { params: Promise<{ brandId: string }> },
): Promise<NextResponse> {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { brandId } = await context.params;
  if (!brandId) {
    return NextResponse.json({ urls: [] });
  }
  try {
    const urls = await getBrandUiScreenshots(brandId);
    return NextResponse.json({ urls });
  } catch (err) {
    console.error("[api/brand-assets] GET failed:", err);
    return NextResponse.json({ urls: [], error: "fetch failed" });
  }
}
