import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { listIndexes, searchMany, enrichClips } from "@/lib/twelvelabs/client";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// POST { query: string, indexIds?: string[] }
// If indexIds omitted/empty → search ALL indexes in the account.
export async function POST(req: Request): Promise<NextResponse> {
  await requireUser();
  let body: { query?: string; indexIds?: string[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }
  const query = (body.query || "").trim();
  if (!query) return NextResponse.json({ error: "query required" }, { status: 400 });

  try {
    let indexIds = body.indexIds?.filter(Boolean) ?? [];
    if (indexIds.length === 0) {
      const all = await listIndexes();
      indexIds = all.map((i) => i.id);
    }
    if (indexIds.length === 0) {
      return NextResponse.json({ clips: [], note: "No indexes found in the account." });
    }
    const clips = await searchMany(query, indexIds);
    const top = clips.slice(0, 48);
    const enriched = await enrichClips(top);
    return NextResponse.json({ clips: enriched, searchedIndexes: indexIds.length });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Search failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
