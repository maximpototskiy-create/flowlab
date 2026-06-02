// GET /api/fal-assets — server-side proxy to the fal Platform Assets API
// (https://api.fal.ai/v1/assets). Keeps the fal key on the server, maps fal's
// asset shape into our AssetItem so the same gallery/drawer can render it.
//
// fal Assets is the whole fal account library (semantic search built in via
// `q`). Note: assets only appear here if the matching request sources are
// enabled in the fal dashboard Assets settings.
import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { nextFalKey } from "@/lib/fal/client";
import type { AssetItem } from "@/lib/assetsQuery";

export const dynamic = "force-dynamic";

type FalAsset = {
  vector_id: string;
  request_id: string | null;
  url: string | null;
  type: "image" | "video" | "audio" | "3d";
  title?: string | null;
  endpoint: string | null;
  created_at: string | null;
  source: string | null;
  prompt: string | null;
  width: number | null;
  height: number | null;
  content_type: string | null;
  is_favorited?: boolean;
  similarity: number | null;
};
type FalBrowseResponse = {
  assets: FalAsset[];
  next_cursor: string | null;
  has_more: boolean;
  total_count: number | null;
};

// fal media type → our kind. fal has "3d"; we don't render it specially, so
// treat it as image for the thumbnail slot (preview may be blank for .glb).
function falKind(t: string): string {
  if (t === "video" || t === "audio" || t === "image") return t;
  return "image";
}

export async function GET(req: Request): Promise<NextResponse> {
  await requireUser();
  const { searchParams } = new URL(req.url);

  // Build the upstream query from our drawer's params.
  const upstream = new URLSearchParams();
  upstream.set("limit", searchParams.get("limit") || "60");
  const q = searchParams.get("q")?.trim();
  if (q) upstream.set("q", q);
  const cursor = searchParams.get("cursor");
  if (cursor) upstream.set("cursor", cursor);
  const mediaType = searchParams.get("media_type"); // single value from our UI
  if (mediaType) upstream.set("media_type", mediaType);
  const section = searchParams.get("section"); // all-media | uploads | favorites
  if (section) upstream.set("section", section);

  let key: string;
  try {
    key = nextFalKey();
  } catch {
    return NextResponse.json(
      { assets: [], next_cursor: null, has_more: false, error: "No fal key configured" },
      { status: 500 },
    );
  }

  try {
    const res = await fetch(`https://api.fal.ai/v1/assets?${upstream.toString()}`, {
      headers: { Authorization: `Key ${key}` },
      cache: "no-store",
    });
    if (!res.ok) {
      const text = await res.text();
      return NextResponse.json(
        { assets: [], next_cursor: null, has_more: false, error: `fal ${res.status}: ${text.slice(0, 200)}` },
        { status: res.status },
      );
    }
    const data = (await res.json()) as FalBrowseResponse;
    const assets: AssetItem[] = (data.assets ?? [])
      .filter((a) => a.url)
      .map((a) => ({
        id: `fal-${a.vector_id}`,
        cdnUrl: a.url as string,
        kind: falKind(a.type),
        mimeType: a.content_type ?? null,
        sizeBytes: null,
        width: a.width ?? null,
        height: a.height ?? null,
        durationSec: null,
        source: "fal",
        model: a.endpoint ?? null,
        prompt: a.prompt ?? a.title ?? null,
        createdAt: a.created_at ?? new Date(0).toISOString(),
        projectName: null,
        brandName: null,
      }));
    return NextResponse.json({ assets, next_cursor: data.next_cursor ?? null, has_more: !!data.has_more });
  } catch (err) {
    console.error("[api/fal-assets] failed:", err);
    return NextResponse.json(
      { assets: [], next_cursor: null, has_more: false, error: "fal request failed" },
      { status: 500 },
    );
  }
}
