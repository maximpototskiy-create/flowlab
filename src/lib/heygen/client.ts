// ─────────────────────────────────────────────────────────────────────────
// HeyGen API client (v3)
//
// Uses the user's HEYGEN_API_KEY (X-Api-Key header). Video generation is
// asynchronous — create a job, then poll GET /v3/videos/{id} until it is
// "completed" or "failed". Confirmed against the v3 Quick Start docs:
//   POST /v3/video-agents     { prompt }            → { data: { video_id } }
//   GET  /v3/videos/{video_id}                       → { data: { status, video_url, ... } }
//
// This foundation covers prompt→avatar-video. Avatar/voice selection, video
// translation, TTS and custom-avatar creation are added in later patches
// (each against its verified v3 reference schema).
// ─────────────────────────────────────────────────────────────────────────

const BASE = "https://api.heygen.com";

function key(): string {
  const k = process.env.HEYGEN_API_KEY;
  if (!k) throw new Error("HEYGEN_API_KEY not set");
  return k;
}

async function heygen<T = unknown>(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "X-Api-Key": key(),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`HeyGen ${res.status}: ${t.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

export type HeyGenVideo = {
  id?: string;
  status: "generating" | "processing" | "pending" | "completed" | "failed" | string;
  video_url?: string;
  thumbnail_url?: string;
  failure_code?: string;
  failure_message?: string;
};

// prompt → avatar video. Returns the new video_id.
export async function createVideoFromPrompt(prompt: string): Promise<string> {
  const data = await heygen<{ data?: { video_id?: string } }>("POST", "/v3/video-agents", { prompt });
  const id = data.data?.video_id;
  if (!id) throw new Error("HeyGen did not return a video_id");
  return id;
}

export async function getVideo(videoId: string): Promise<HeyGenVideo> {
  const data = await heygen<{ data?: HeyGenVideo }>("GET", `/v3/videos/${videoId}`);
  if (!data.data) throw new Error("HeyGen returned no video data");
  return data.data;
}

// Poll until the render finishes. Capped because the caller (a workflow run)
// is itself time-bounded by the serverless/Inngest limit (~300s). Short
// avatar clips usually finish well within this; very long renders may hit the
// cap and surface a clear timeout error rather than hanging.
export async function pollVideo(
  videoId: string,
  opts?: { timeoutMs?: number; intervalMs?: number },
): Promise<string> {
  const timeoutMs = opts?.timeoutMs ?? 240_000; // ~4 min
  const intervalMs = opts?.intervalMs ?? 8_000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const v = await getVideo(videoId);
    if (v.status === "completed") {
      if (!v.video_url) throw new Error("HeyGen completed but returned no video_url");
      return v.video_url;
    }
    if (v.status === "failed") {
      throw new Error(`HeyGen render failed: ${v.failure_message ?? v.failure_code ?? "unknown"}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("HeyGen render timed out (still processing). Try a shorter video or check the HeyGen dashboard.");
}
