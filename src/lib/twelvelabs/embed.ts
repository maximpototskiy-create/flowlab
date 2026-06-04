// ─────────────────────────────────────────────────────────────────────────
// TwelveLabs Embed API v2 (Marengo 3.0). Single 512-d space for text, images,
// and video — so a text query and an image/video asset are directly comparable.
//
//   • Sync  /embed-v2        → text, images (instant). Body needs input_type.
//   • Async /embed-v2/tasks  → video/audio (clip segments). Poll for results.
// ─────────────────────────────────────────────────────────────────────────

import sharp from "sharp";

const BASE = "https://api.twelvelabs.io/v1.3";
const MODEL = "marengo3.0";

function key(): string {
  const k = process.env.TWELVELABS_API_KEY;
  if (!k) throw new Error("TWELVELABS_API_KEY not set");
  return k;
}

export type VideoSegment = { embedding: number[]; startSec: number; endSec: number; option: string | null };

// ─── Sync (text / image) ───────────────────────────────────────────────────

async function embedSync(body: Record<string, unknown>): Promise<Array<Record<string, unknown>>> {
  const res = await fetch(`${BASE}/embed-v2`, {
    method: "POST",
    headers: { "x-api-key": key(), "Content-Type": "application/json" },
    body: JSON.stringify({ model_name: MODEL, ...body }),
    cache: "no-store",
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`embed-v2 ${res.status}: ${t.slice(0, 300)}`);
  }
  const j = (await res.json()) as { data?: Array<Record<string, unknown>> };
  return j.data ?? [];
}

// Embed a text query → one 512-d vector.
export async function embedText(text: string): Promise<number[]> {
  const data = await embedSync({ input_type: "text", text: { input_text: text.slice(0, 1800) } });
  const emb = data[0]?.embedding as number[] | undefined;
  if (!emb) throw new Error("No text embedding returned");
  return emb;
}

// Embed an image by public URL → one 512-d vector.
// Embed an image by URL → one 512-d vector. Marengo only accepts JPEG/PNG,
// so we download the image and normalize it to JPEG (handles WebP, etc.),
// then send it inline as base64.
export async function embedImage(url: string): Promise<number[]> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch image ${res.status}`);
  const input = Buffer.from(await res.arrayBuffer());
  // Normalize any format (webp/gif/heic/…) to JPEG. flatten() drops alpha.
  const jpeg = await sharp(input).flatten({ background: "#ffffff" }).jpeg({ quality: 90 }).toBuffer();
  const b64 = jpeg.toString("base64");
  const data = await embedSync({ input_type: "image", image: { media_source: { base_64_string: b64 } } });
  const emb = data[0]?.embedding as number[] | undefined;
  if (!emb) throw new Error("No image embedding returned");
  return emb;
}

// ─── Async (video) ───────────────────────────────────────────────────────

// Create an async video embedding task (clip-level). Returns the task id.
export async function embedVideo(url: string): Promise<{ taskId: string }> {
  return embedAsyncMedia("video", url);
}

// Create an async audio embedding task (clip-level). Returns the task id.
export async function embedAudio(url: string): Promise<{ taskId: string }> {
  return embedAsyncMedia("audio", url);
}

async function embedAsyncMedia(inputType: "video" | "audio", url: string): Promise<{ taskId: string }> {
  const res = await fetch(`${BASE}/embed-v2/tasks`, {
    method: "POST",
    headers: { "x-api-key": key(), "Content-Type": "application/json" },
    body: JSON.stringify({
      input_type: inputType,
      model_name: MODEL,
      [inputType]: {
        media_source: { url },
        // visual-text for video (aligned with text search); audio for audio.
        // Valid video options: visual | audio | transcription. (Not "visual-text".)
        embedding_option: inputType === "video" ? ["visual"] : ["audio"],
        embedding_scope: ["clip"],
      },
    }),
    cache: "no-store",
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`embed-v2/tasks ${res.status}: ${t.slice(0, 300)}`);
  }
  const j = (await res.json()) as { _id?: string };
  return { taskId: j._id || "" };
}

// Retrieve a finished embedding task (video or audio) → segments (null if not ready).
export async function retrieveEmbeddingTask(taskId: string): Promise<VideoSegment[] | null> {
  const r = await getEmbedTaskStatus(taskId);
  return r.status === "ready" ? r.segments : null;
}

// Full status of an embed task: status + segments (when ready) + error text.
export async function getEmbedTaskStatus(
  taskId: string,
): Promise<{ status: string; segments: VideoSegment[]; error: string | null }> {
  const res = await fetch(`${BASE}/embed-v2/tasks/${taskId}`, { headers: { "x-api-key": key() }, cache: "no-store" });
  if (!res.ok) {
    const t = await res.text();
    return { status: "unknown", segments: [], error: `${res.status}: ${t.slice(0, 200)}` };
  }
  const j = (await res.json()) as {
    status?: string;
    error?: string;
    message?: string;
    data?: Array<{
      embedding?: number[];
      embeddings_float?: number[];
      start_offset_sec?: number;
      end_offset_sec?: number;
      start_sec?: number;
      end_sec?: number;
      embedding_option?: string;
      embedding_scope?: string;
    }>;
  };
  const status = j.status ?? "unknown";
  if (status !== "ready") {
    return { status, segments: [], error: status === "failed" ? j.error ?? j.message ?? "task failed" : null };
  }
  const segments = (j.data ?? [])
    .filter((s) => (s.embedding ?? s.embeddings_float)?.length)
    .map((s) => ({
      embedding: (s.embedding ?? s.embeddings_float) as number[],
      startSec: s.start_offset_sec ?? s.start_sec ?? 0,
      endSec: s.end_offset_sec ?? s.end_sec ?? 0,
      option: s.embedding_option ?? null,
    }));
  return { status, segments, error: null };
}

// Back-compat alias (brand-assets route imports this name).
export const retrieveVideoEmbedding = retrieveEmbeddingTask;
