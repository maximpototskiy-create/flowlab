// ─────────────────────────────────────────────────────────────────────────
// TwelveLabs client (Marengo 3.0). Public API — works from Vercel, no VPN.
//
// Auth: header `x-api-key`. Base: https://api.twelvelabs.io/v1.3
// Search is per-index, so to search "everything" we list indexes and fan out.
// ─────────────────────────────────────────────────────────────────────────

const BASE = "https://api.twelvelabs.io/v1.3";

function key(): string {
  const k = process.env.TWELVELABS_API_KEY;
  if (!k) throw new Error("TWELVELABS_API_KEY not set");
  return k;
}

export type TLIndex = { id: string; name: string };

export type TLClip = {
  indexId: string;
  videoId: string;
  rank: number; // 1 = most relevant (Marengo 3.0)
  start: number;
  end: number;
  thumbnailUrl: string | null;
  hlsUrl: string | null;
  filename: string | null;
};

// List all indexes in the account (paginated; we pull up to ~150).
export async function listIndexes(): Promise<TLIndex[]> {
  const out: TLIndex[] = [];
  for (let page = 1; page <= 3; page++) {
    const res = await fetch(`${BASE}/indexes?page=${page}&page_limit=50&sort_by=created_at&sort_option=desc`, {
      headers: { "x-api-key": key() },
      cache: "no-store",
    });
    if (!res.ok) break;
    const json = (await res.json()) as { data?: Array<Record<string, unknown>> };
    const rows = json.data ?? [];
    for (const r of rows) {
      const id = (r._id as string) || (r.id as string);
      const name = (r.index_name as string) || (r.name as string) || id;
      if (id) out.push({ id, name });
    }
    if (rows.length < 50) break;
  }
  return out;
}

// Search a single index by text. Marengo 3.0 returns `rank` (1 = best).
export async function searchIndex(indexId: string, queryText: string, limit = 10): Promise<TLClip[]> {
  const form = new FormData();
  form.append("index_id", indexId);
  form.append("query_text", queryText);
  form.append("search_options", "visual");
  form.append("search_options", "audio");
  form.append("page_limit", String(limit));

  const res = await fetch(`${BASE}/search`, {
    method: "POST",
    headers: { "x-api-key": key() },
    body: form,
    cache: "no-store",
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`TwelveLabs search ${res.status}: ${t.slice(0, 200)}`);
  }
  const json = (await res.json()) as { data?: Array<Record<string, unknown>> };
  return (json.data ?? []).map((c) => ({
    indexId,
    videoId: (c.video_id as string) || "",
    rank: typeof c.rank === "number" ? c.rank : 9999,
    start: typeof c.start === "number" ? c.start : 0,
    end: typeof c.end === "number" ? c.end : 0,
    thumbnailUrl: (c.thumbnail_url as string) || null,
    hlsUrl: null,
    filename: null,
  }));
}

// Search across multiple indexes (or all) and merge by rank (ascending).
export async function searchMany(
  queryText: string,
  indexIds: string[],
  perIndexLimit = 8,
): Promise<TLClip[]> {
  const results = await Promise.allSettled(indexIds.map((id) => searchIndex(id, queryText, perIndexLimit)));
  const clips: TLClip[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") clips.push(...r.value);
  }
  return clips.sort((a, b) => a.rank - b.rank);
}

// Retrieve a video's HLS stream URL, thumbnail and filename.
export async function getVideoInfo(
  indexId: string,
  videoId: string,
): Promise<{ hlsUrl: string | null; thumbnailUrl: string | null; filename: string | null }> {
  const res = await fetch(`${BASE}/indexes/${indexId}/videos/${videoId}`, {
    headers: { "x-api-key": key() },
    cache: "no-store",
  });
  if (!res.ok) return { hlsUrl: null, thumbnailUrl: null, filename: null };
  const j = (await res.json()) as {
    hls?: { video_url?: string; thumbnail_urls?: string[] };
    system_metadata?: { filename?: string; video_title?: string };
  };
  return {
    hlsUrl: j.hls?.video_url ?? null,
    thumbnailUrl: j.hls?.thumbnail_urls?.[0] ?? null,
    filename: j.system_metadata?.filename ?? j.system_metadata?.video_title ?? null,
  };
}

// Enrich clips with video info (filename, thumbnail, HLS) — deduped by video.
export async function enrichClips(clips: TLClip[], maxVideos = 30): Promise<TLClip[]> {
  const byVideo = new Map<string, { indexId: string; videoId: string }>();
  for (const c of clips) {
    if (c.videoId && !byVideo.has(c.videoId)) byVideo.set(c.videoId, { indexId: c.indexId, videoId: c.videoId });
    if (byVideo.size >= maxVideos) break;
  }
  const infos = await Promise.allSettled(
    [...byVideo.values()].map(async (v) => ({ id: v.videoId, info: await getVideoInfo(v.indexId, v.videoId) })),
  );
  const map = new Map<string, { hlsUrl: string | null; thumbnailUrl: string | null; filename: string | null }>();
  for (const r of infos) if (r.status === "fulfilled") map.set(r.value.id, r.value.info);
  return clips.map((c) => {
    const info = map.get(c.videoId);
    return info ? { ...c, hlsUrl: info.hlsUrl, thumbnailUrl: c.thumbnailUrl ?? info.thumbnailUrl, filename: info.filename } : c;
  });
}
