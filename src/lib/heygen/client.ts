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

// ───────────────────────── v2: avatars / voices / explicit generation ─────
// GET /v2/avatars  → { data: { avatars: [...], talking_photos: [...] } }
// GET /v2/voices   → { data: { voices: [...] } }
// POST /v2/video/generate with explicit character+voice — the "full" mode.
// Status for v2 jobs is polled via GET /v1/video_status.get?video_id=…

export type HeyGenAvatar = { id: string; name: string; preview: string | null; gender?: string | null };
export type HeyGenVoice = { id: string; name: string; language: string | null; gender?: string | null; preview: string | null };

export async function listAvatars(): Promise<HeyGenAvatar[]> {
  // /v2/avatars returns the full set in one call for most accounts, but some
  // paginate via ?page / token. We follow up to a few pages defensively so the
  // list isn't silently truncated to the first letters of the alphabet.
  const out: HeyGenAvatar[] = [];
  type Raw = { avatar_id: string; avatar_name?: string; preview_image_url?: string; gender?: string };
  type Resp = { data?: { avatars?: Raw[]; talking_photos?: { talking_photo_id: string; talking_photo_name?: string; preview_image_url?: string }[]; token?: string | null; next_page?: string | null } };
  let path = "/v2/avatars";
  for (let i = 0; i < 8; i++) {
    const data = await heygen<Resp>("GET", path);
    for (const a of data.data?.avatars ?? []) out.push({ id: a.avatar_id, name: a.avatar_name || a.avatar_id, preview: a.preview_image_url || null, gender: a.gender ?? null });
    const tok = data.data?.token || data.data?.next_page;
    if (!tok) break;
    path = `/v2/avatars?token=${encodeURIComponent(tok)}`;
  }
  // de-dupe by id (pagination overlaps can repeat the boundary item)
  const seen = new Set<string>();
  return out.filter((a) => (seen.has(a.id) ? false : (seen.add(a.id), true)));
}

export async function listVoices(): Promise<HeyGenVoice[]> {
  const data = await heygen<{ data?: { voices?: { voice_id: string; name?: string; language?: string; gender?: string; preview_audio?: string }[] } }>("GET", "/v2/voices");
  return (data.data?.voices ?? []).map((v) => ({
    id: v.voice_id, name: v.name || v.voice_id, language: v.language ?? null, gender: v.gender ?? null, preview: v.preview_audio || null,
  }));
}

export async function createAvatarVideo(opts: {
  script: string;
  voiceId: string;
  avatarId?: string;        // library avatar
  talkingPhotoId?: string;  // custom avatar built from an uploaded image
  avatarStyle?: string;     // normal | circle | closeUp
  width?: number;
  height?: number;
  background?: string;      // hex color, e.g. "#008000" — keyable later in the editor
  speed?: number;           // 0.5 – 1.5
}): Promise<string> {
  const character = opts.talkingPhotoId
    ? { type: "talking_photo", talking_photo_id: opts.talkingPhotoId }
    : { type: "avatar", avatar_id: opts.avatarId, avatar_style: opts.avatarStyle || "normal" };
  const body = {
    video_inputs: [
      {
        character,
        voice: { type: "text", input_text: opts.script, voice_id: opts.voiceId, ...(opts.speed && opts.speed !== 1 ? { speed: opts.speed } : {}) },
        ...(opts.background ? { background: { type: "color", value: opts.background } } : {}),
      },
    ],
    dimension: { width: opts.width ?? 720, height: opts.height ?? 1280 },
  };
  const data = await heygen<{ data?: { video_id?: string }; error?: { message?: string } }>("POST", "/v2/video/generate", body);
  const id = data.data?.video_id;
  if (!id) throw new Error(data.error?.message || "HeyGen did not return a video_id");
  return id;
}

// Upload an image (by URL) to HeyGen as a Talking Photo → returns its id, so a
// generated/brand avatar picture can speak. Upload host differs from the API host.
export async function uploadTalkingPhoto(imageUrl: string): Promise<string> {
  const img = await fetch(imageUrl);
  if (!img.ok) throw new Error(`Could not fetch avatar image (${img.status})`);
  const ct = img.headers.get("content-type") || "image/jpeg";
  const contentType = ct.includes("png") ? "image/png" : ct.includes("webp") ? "image/webp" : "image/jpeg";
  const buf = Buffer.from(await img.arrayBuffer());
  const res = await fetch("https://upload.heygen.com/v1/talking_photo", {
    method: "POST",
    headers: { "X-Api-Key": key(), "Content-Type": contentType },
    body: buf,
  });
  const j = (await res.json()) as { data?: { talking_photo_id?: string }; message?: string };
  if (!res.ok || !j.data?.talking_photo_id) throw new Error(j.message || `HeyGen talking-photo upload failed (${res.status})`);
  return j.data.talking_photo_id;
}

// v1 status endpoint — the documented way to poll v2 generations.
export async function pollVideoStatus(
  videoId: string,
  opts?: { timeoutMs?: number; intervalMs?: number },
): Promise<string> {
  const timeoutMs = opts?.timeoutMs ?? 240_000;
  const intervalMs = opts?.intervalMs ?? 8_000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const data = await heygen<{ data?: { status?: string; video_url?: string; error?: { message?: string } | null } }>(
      "GET", `/v1/video_status.get?video_id=${encodeURIComponent(videoId)}`);
    const d = data.data;
    if (d?.status === "completed") {
      if (!d.video_url) throw new Error("HeyGen completed but returned no video_url");
      return d.video_url;
    }
    if (d?.status === "failed") throw new Error(`HeyGen render failed: ${d.error?.message ?? "unknown"}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("HeyGen render timed out (still processing). Try a shorter script or check the HeyGen dashboard.");
}
