// GET /api/assets — JSON asset feed for the canvas asset drawer. Same query
// logic as the /assets page. Filters via query string: kind, source, project,
// brand, q.
import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { queryAssets } from "@/lib/assetsQuery";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<NextResponse> {
  await requireUser();
  const { searchParams } = new URL(req.url);
  const get = (k: string) => searchParams.get(k) || undefined;
  const limit = Math.min(Number(searchParams.get("limit")) || 120, 600);
  try {
    const data = await queryAssets({
      project: get("project"),
      brand: get("brand"),
      kind: get("kind"),
      source: get("source"),
      q: get("q")?.trim(),
      limit,
    });
    return NextResponse.json(data);
  } catch (err) {
    console.error("[api/assets] failed:", err);
    return NextResponse.json({ assets: [], projects: [], brands: [] }, { status: 500 });
  }
}
