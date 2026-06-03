// ─────────────────────────────────────────────────────────────────────────
// TwelveLabs Embed API v2 (Marengo 3.0). Single 512-d space for text, images,
// and video — so a text query and an image/video asset are directly comparable.
//
// Sync endpoint /embed-v2: text, images, and audio/video under 10 min.
// We use it for text + image (instant). Video uses the async embed task.
// ─────────────────────────────────────────────────────────────────────────

const BASE = "https://api.twelvelabs.io/v1.3";
const MODEL = "marengo3.0";

function key(): string {
  const k = process.env.TWELVELABS_API_KEY;
  if (!k) throw new Error("TWELVELABS_API_KEY not set");
  return k;
}

export type VideoSegment = { embedding: number[]; startSec: number; endSec: number; option: string | null };

async function embedV2(body: Record<string, unknown>): Promise<Array<Record<string, unknown>>> {
  const res = await fetch(`${BASE}/embed-v2`, {
    method: "POST",
    headers: { "x-api-key": key(), "Content-Type": "application/json" },
    body: JSON.stringify({ model_name: MODEL, ...body }),
    cache: "no-store",
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`TwelveLabs embed-v2 ${res.status}: ${t.slice(0, 200)}`);
  }
  const j = (await res.json()) as { data?: Array<Record<string, unknown>> };
  return j.data ?? [];
}

// Embed a text query → one 512-d vector.
export async function embedText(text: string): Promise<number[]> {
  const data = await embedV2({ text: { input_text: text.slice(0, 2000) } });
  const emb = data[0]?.embedding as number[] | undefined;
  if (!emb) throw new Error("No text embedding returned");
  return emb;
}

// Embed an image by public URL → one 512-d vector.
export async function embedImage(url: string): Promise<number[]> {
  const data = await embedV2({ image: { media_source: { url } } });
  const emb = data[0]?.embedding as number[] | undefined;
  if (!emb) throw new Error("No image embedding returned");
  return emb;
}

// Embed a video by public URL (async task). Returns clip-level segments.
// Used for videos that should be searchable at moment granularity.
export async function embedVideo(url: string, maxWaitMs = 0): Promise<{ taskId: string; segments: VideoSegment[] }> {
  // Create the async embedding task.
  const form = new FormData();
  form.append("model_name", MODEL);
  form.append("video_url", url);
  form.append("video_embedding_scope", "clip");
  const res = await fetch(`${BASE}/embed/tasks`, {
    method: "POST",
    headers: { "x-api-key": key() },
    body: form,
    cache: "no-store",
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`TwelveLabs embed task ${res.status}: ${t.slice(0, 200)}`);
  }
  const created = (await res.json()) as { _id?: string };
  const taskId = created._id || "";

  // Optionally poll until ready (used by background jobs, not request path).
  const segments: VideoSegment[] = [];
  if (maxWaitMs > 0 && taskId) {
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 3000));
      const segs = await retrieveVideoEmbedding(taskId);
      if (segs) {
        segments.push(...segs);
        break;
      }
    }
  }
  return { taskId, segments };
}

// Retrieve a finished video embedding task → segments (null if not ready).
export async function retrieveVideoEmbedding(taskId: string): Promise<VideoSegment[] | null> {
  const res = await fetch(`${BASE}/embed/tasks/${taskId}`, { headers: { "x-api-key": key() }, cache: "no-store" });
  if (!res.ok) return null;
  const j = (await res.json()) as {
    status?: string;
    video_embedding?: { segments?: Array<{ embedding?: number[]; embeddings_float?: number[]; start_offset_sec?: number; end_offset_sec?: number; embedding_option?: string }> };
  };
  if (j.status !== "ready") return null;
  const segs = j.video_embedding?.segments ?? [];
  return segs.map((s) => ({
    embedding: s.embedding ?? s.embeddings_float ?? [],
    startSec: s.start_offset_sec ?? 0,
    endSec: s.end_offset_sec ?? 0,
    option: s.embedding_option ?? null,
  }));
}
