// POST /api/brand-assets/embed-skipped { brandId }
// Starts embedding tasks for assets imported in fast mode (embedStatus "skipped").
// Small batch per call; the editor loops this in the background after a Drive
// sync so the whole library gets indexed right away (the nightly cron remains
// as a safety net for anything missed).
import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { embedSkippedBatch } from "@/lib/driveImport";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MAX_PER_CALL = 3; // each start pads the video with ffmpeg — keep the call snappy

export async function POST(req: Request): Promise<NextResponse> {
  await requireUser();
  let body: { brandId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }
  if (!body.brandId) return NextResponse.json({ error: "brandId required" }, { status: 400 });

  try {
    const r = await embedSkippedBatch(body.brandId, MAX_PER_CALL);
    return NextResponse.json({ ok: true, ...r });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "embed failed" }, { status: 500 });
  }
}
