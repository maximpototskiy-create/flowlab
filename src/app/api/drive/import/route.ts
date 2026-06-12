// POST /api/drive/import { brandId } — manual import (button).
// Thin wrapper over importBrandBatch (shared with the cron).
import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { importBrandBatch } from "@/lib/driveImport";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MAX_PER_RUN = 3; // small batch = fast responses; heavy embeds deferred to the cron

export async function POST(req: Request): Promise<NextResponse> {
  await requireUser();
  let body: { brandId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }
  if (!body.brandId) return NextResponse.json({ error: "brandId required" }, { status: 400 });

  const result = await importBrandBatch(body.brandId, MAX_PER_RUN, { skipHeavyEmbeds: true });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 500 });
  return NextResponse.json(result);
}
