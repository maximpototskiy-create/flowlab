// GET /api/assets — JSON asset feed for the canvas asset drawer. Same query
// logic as the /assets page. Filters via query string: kind, source, project,
// brand, q.
import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { queryAssets } from "@/lib/assetsQuery";
import { prisma } from "@/lib/prisma";
import { deleteObject } from "@/lib/storage";

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

// DELETE /api/assets?id=<uuid> — permanently remove a stored asset (the DB row
// AND its storage object). Used to clean up test generations so they no longer
// load anywhere. Any signed-in user may delete (single-tenant tool, matching the
// unscoped GET feed). Deleting the row cascades to brand-kit usages.
export async function DELETE(req: Request): Promise<NextResponse> {
  await requireUser();
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  try {
    const asset = await prisma.asset.findUnique({ where: { id }, select: { storagePath: true } });
    if (!asset) return NextResponse.json({ error: "Not found" }, { status: 404 });
    // Remove the DB row first (cascades to brand-kit usages). The storage object
    // is best-effort — a storage failure must NOT leave a dangling row behind.
    await prisma.asset.delete({ where: { id } });
    if (asset.storagePath) {
      try { await deleteObject(asset.storagePath); }
      catch (e) { console.error("[api/assets DELETE] storage cleanup failed:", e); }
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[api/assets DELETE] failed:", err);
    return NextResponse.json({ error: "Delete failed" }, { status: 500 });
  }
}
