// POST /api/semantic-search
//   { query?: string, imageUrl?: string, brandId?, modality?, category?, limit? }
// Embeds the query (text or image) with Marengo and runs cosine search over
// our pgvector index. Video segments are grouped back to one asset card.
import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { embedText, embedImage } from "@/lib/twelvelabs/embed";
import { searchEmbeddings, type SemanticHit } from "@/lib/semantic";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

type Moment = { startSec: number | null; endSec: number | null; similarity: number };
type AssetResult = {
  assetId: string | null;
  url: string;
  modality: string;
  category: string | null;
  brandId: string | null;
  similarity: number; // best
  moments: Moment[]; // for video
  matches: number;
};

export async function POST(req: Request): Promise<NextResponse> {
  await requireUser();
  let body: { query?: string; imageUrl?: string; brandId?: string; modality?: string; category?: string; limit?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }
  const query = (body.query || "").trim();
  const imageUrl = (body.imageUrl || "").trim();
  if (!query && !imageUrl) return NextResponse.json({ error: "query or imageUrl required" }, { status: 400 });

  try {
    const embedding = imageUrl ? await embedImage(imageUrl) : await embedText(query);
    // Pull extra rows so grouping by asset still yields enough cards.
    const hits = await searchEmbeddings({
      embedding,
      brandId: body.brandId || null,
      modality: body.modality || null,
      category: body.category || null,
      limit: Math.min(body.limit ?? 60, 120),
    });

    // Group video segments back to one card per asset; keep best similarity.
    const byKey = new Map<string, AssetResult>();
    for (const h of hits as SemanticHit[]) {
      const keyId = h.assetId || h.url;
      const existing = byKey.get(keyId);
      if (existing) {
        existing.matches++;
        if (h.similarity > existing.similarity) existing.similarity = h.similarity;
        if (h.modality === "video") existing.moments.push({ startSec: h.startSec, endSec: h.endSec, similarity: h.similarity });
      } else {
        byKey.set(keyId, {
          assetId: h.assetId,
          url: h.url,
          modality: h.modality,
          category: h.category,
          brandId: h.brandId,
          similarity: h.similarity,
          moments: h.modality === "video" ? [{ startSec: h.startSec, endSec: h.endSec, similarity: h.similarity }] : [],
          matches: 1,
        });
      }
    }
    const results = [...byKey.values()]
      .map((r) => ({ ...r, moments: r.moments.sort((a, b) => b.similarity - a.similarity).slice(0, 5) }))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, 48);

    return NextResponse.json({ results });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Search failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
