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
  score: number;
  start: number;
  end: number;
  thumbnailUrl: string | null;
  confidence: string | null;
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

// Search a single index by text. Returns clips sorted by score (desc).
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
    score: typeof c.score === "number" ? c.score : 0,
    start: typeof c.start === "number" ? c.start : 0,
    end: typeof c.end === "number" ? c.end : 0,
    thumbnailUrl: (c.thumbnail_url as string) || null,
    confidence: (c.confidence as string) || null,
  }));
}

// Search across multiple indexes (or all) and merge by score.
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
  return clips.sort((a, b) => b.score - a.score);
}
