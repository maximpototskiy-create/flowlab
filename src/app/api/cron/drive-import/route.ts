// GET /api/cron/drive-import — scheduled auto-import for all brands.
// Triggered by Vercel Cron (see vercel.json). Walks brands and pulls a small
// batch of new Drive files each run, so files dropped into Drive show up in the
// library automatically. Protected by CRON_SECRET (or Vercel's cron header).
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { importBrandBatch, embedSkippedBatch } from "@/lib/driveImport";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MAX_PER_BRAND = 4; // bounded per brand per run; next run continues

function authorized(req: Request): boolean {
  // Vercel Cron sends this header; manual triggers can pass CRON_SECRET.
  if (req.headers.get("x-vercel-cron")) return true;
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = req.headers.get("authorization");
  return auth === `Bearer ${secret}`;
}

export async function GET(req: Request): Promise<NextResponse> {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // Only brands that have a Drive folder (resolved at least once).
  const brands = await prisma.brand.findMany({
    where: { archivedAt: null, driveFolderId: { not: null } },
    select: { id: true, name: true },
  });

  const summary: Array<{ brand: string; imported: number; videos: number; remaining: number; error?: string }> = [];
  for (const b of brands) {
    try {
      const r = await importBrandBatch(b.id, MAX_PER_BRAND);
      await embedSkippedBatch(b.id, 3).catch(() => {});
      summary.push({
        brand: b.name,
        imported: r.imported ?? 0,
        videos: r.videos ?? 0,
        remaining: r.remaining ?? 0,
        error: r.ok ? undefined : r.error,
      });
    } catch (err) {
      summary.push({ brand: b.name, imported: 0, videos: 0, remaining: 0, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return NextResponse.json({ ok: true, brands: brands.length, summary });
}
