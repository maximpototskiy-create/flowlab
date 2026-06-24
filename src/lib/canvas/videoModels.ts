// Catalog of video-generation models available on fal, with the canvas modes
// each one serves and its real duration limits (verified against fal docs,
// June 2026). The videoGen node UI reads this to:
//   • show only the models that fit the chosen Mode, grouped by family;
//   • offer the right duration control (a 1s-step slider where the model
//     supports a range, fixed buttons where it doesn't).
// The runner (runners.ts) still coerces duration per-model as a safety net,
// so an imperfect value here can never hard-fail a generation.

export type VideoMode = "text" | "image" | "keyframes" | "references" | "multi-shot" | "video-to-video";

export type VideoDuration =
  | { kind: "range"; min: number; max: number; step: number; default: number }
  | { kind: "enum"; values: number[]; default: number };

export type VideoModelDef = {
  id: string;
  label: string;
  family: string;
  modes: VideoMode[];
  duration: VideoDuration;
  audio?: boolean; // exposes the "Generate audio" toggle
  resolutions?: string[]; // selectable output resolutions (omit = model has no choice)
  recommended?: boolean;
};

const RANGE_3_15: VideoDuration = { kind: "range", min: 3, max: 15, step: 1, default: 5 };
const RANGE_4_15: VideoDuration = { kind: "range", min: 4, max: 15, step: 1, default: 5 };
const VEO_DUR: VideoDuration = { kind: "enum", values: [4, 6, 8], default: 8 };
const DUR_5_10: VideoDuration = { kind: "enum", values: [5, 10], default: 5 };

export const VIDEO_MODELS: VideoModelDef[] = [
  // ─── Kling 3.0 (V3) — newest flagship, 3–15s, native audio, multi_prompt ───
  { id: "fal-ai/kling-video/v3/pro/image-to-video", label: "Kling 3.0 Pro", family: "Kling 3.0", modes: ["image", "keyframes", "multi-shot"], duration: RANGE_3_15, audio: true, recommended: true },
  { id: "fal-ai/kling-video/v3/standard/image-to-video", label: "Kling 3.0 Standard", family: "Kling 3.0", modes: ["image", "keyframes", "multi-shot"], duration: RANGE_3_15, audio: true },
  { id: "fal-ai/kling-video/v3/4k/image-to-video", label: "Kling 3.0 4K", family: "Kling 3.0", modes: ["image", "keyframes", "multi-shot"], duration: RANGE_3_15, audio: true },
  { id: "fal-ai/kling-video/v3/pro/text-to-video", label: "Kling 3.0 Pro", family: "Kling 3.0", modes: ["text", "multi-shot"], duration: RANGE_3_15, audio: true, recommended: true },
  { id: "fal-ai/kling-video/v3/standard/text-to-video", label: "Kling 3.0 Standard", family: "Kling 3.0", modes: ["text", "multi-shot"], duration: RANGE_3_15, audio: true },
  { id: "fal-ai/kling-video/v3/4k/text-to-video", label: "Kling 3.0 4K", family: "Kling 3.0", modes: ["text", "multi-shot"], duration: RANGE_3_15, audio: true },

  // ─── Kling O3 — prior flagship, 3–15s, references + video-to-video ───
  { id: "fal-ai/kling-video/o3/pro/image-to-video", label: "Kling O3 Pro", family: "Kling O3", modes: ["image", "keyframes", "multi-shot"], duration: RANGE_3_15, audio: true },
  { id: "fal-ai/kling-video/o3/standard/image-to-video", label: "Kling O3 Standard", family: "Kling O3", modes: ["image", "keyframes", "multi-shot"], duration: RANGE_3_15, audio: true },
  { id: "fal-ai/kling-video/o3/4k/image-to-video", label: "Kling O3 4K", family: "Kling O3", modes: ["image", "keyframes", "multi-shot"], duration: RANGE_3_15, audio: true },
  { id: "fal-ai/kling-video/o3/pro/text-to-video", label: "Kling O3 Pro", family: "Kling O3", modes: ["text", "multi-shot"], duration: RANGE_3_15, audio: true },
  { id: "fal-ai/kling-video/o3/standard/text-to-video", label: "Kling O3 Standard", family: "Kling O3", modes: ["text", "multi-shot"], duration: RANGE_3_15, audio: true },
  { id: "fal-ai/kling-video/o3/4k/text-to-video", label: "Kling O3 4K", family: "Kling O3", modes: ["text", "multi-shot"], duration: RANGE_3_15, audio: true },
  // Kling reference-to-video (Reference I2V) is on the O1 line, not o3, and runs
  // at 5/10s. Refs go in as @Image1 / @Element1 (auto-injected into the prompt).
  { id: "fal-ai/kling-video/o1/reference-to-video", label: "Kling O1 Pro", family: "Kling O1", modes: ["references"], duration: DUR_5_10 },
  { id: "fal-ai/kling-video/o1/standard/reference-to-video", label: "Kling O1 Standard", family: "Kling O1", modes: ["references"], duration: DUR_5_10 },
  // Video-to-Video lives on the Kling O1 (Omni) line, NOT o3. Pro has no
  // "/pro/" segment; standard does. Duration/aspect derive from the source
  // video (the endpoints have no duration/aspect_ratio fields).
  { id: "fal-ai/kling-video/o1/video-to-video/edit", label: "Kling O1 Pro — Edit", family: "Kling O1", modes: ["video-to-video"], duration: RANGE_3_15 },
  { id: "fal-ai/kling-video/o1/standard/video-to-video/edit", label: "Kling O1 Standard — Edit", family: "Kling O1", modes: ["video-to-video"], duration: RANGE_3_15 },
  { id: "fal-ai/kling-video/o1/video-to-video/reference", label: "Kling O1 Pro — Restyle", family: "Kling O1", modes: ["video-to-video"], duration: RANGE_3_15 },
  { id: "fal-ai/kling-video/o1/standard/video-to-video/reference", label: "Kling O1 Standard — Restyle", family: "Kling O1", modes: ["video-to-video"], duration: RANGE_3_15 },

  // ─── Seedance 2.0 (ByteDance) — 4–15s, native audio, multi-modal refs ───
  { id: "bytedance/seedance-2.0/image-to-video", label: "Seedance 2.0", family: "Seedance 2.0", modes: ["image", "keyframes", "multi-shot"], duration: RANGE_4_15, audio: true, resolutions: ["720p", "1080p"], recommended: true },
  { id: "bytedance/seedance-2.0/fast/image-to-video", label: "Seedance 2.0 Fast", family: "Seedance 2.0", modes: ["image", "keyframes", "multi-shot"], duration: RANGE_4_15, audio: true, resolutions: ["720p", "1080p"] },
  { id: "bytedance/seedance-2.0/text-to-video", label: "Seedance 2.0", family: "Seedance 2.0", modes: ["text", "multi-shot"], duration: RANGE_4_15, audio: true, resolutions: ["720p", "1080p"] },
  { id: "bytedance/seedance-2.0/fast/text-to-video", label: "Seedance 2.0 Fast", family: "Seedance 2.0", modes: ["text", "multi-shot"], duration: RANGE_4_15, audio: true, resolutions: ["720p", "1080p"] },
  { id: "bytedance/seedance-2.0/reference-to-video", label: "Seedance 2.0", family: "Seedance 2.0", modes: ["references"], duration: RANGE_4_15, audio: true, resolutions: ["720p", "1080p"] },
  { id: "bytedance/seedance-2.0/fast/reference-to-video", label: "Seedance 2.0 Fast", family: "Seedance 2.0", modes: ["references"], duration: RANGE_4_15, audio: true, resolutions: ["720p", "1080p"] },

  // ─── Veo 3.1 (Google) — fixed 4/6/8s, audio ───
  { id: "fal-ai/veo3.1/fast", label: "Veo 3.1 Fast", family: "Veo 3.1", modes: ["text"], duration: VEO_DUR, audio: true, resolutions: ["720p", "1080p"], recommended: true },
  { id: "fal-ai/veo3.1", label: "Veo 3.1 Standard", family: "Veo 3.1", modes: ["text"], duration: VEO_DUR, audio: true, resolutions: ["720p", "1080p"] },
  { id: "fal-ai/veo3.1/fast/image-to-video", label: "Veo 3.1 Fast", family: "Veo 3.1", modes: ["image"], duration: VEO_DUR, audio: true, resolutions: ["720p", "1080p"], recommended: true },
  { id: "fal-ai/veo3.1/image-to-video", label: "Veo 3.1 Standard", family: "Veo 3.1", modes: ["image"], duration: VEO_DUR, audio: true, resolutions: ["720p", "1080p"] },
  { id: "fal-ai/veo3.1/fast/first-last-frame-to-video", label: "Veo 3.1 Fast", family: "Veo 3.1", modes: ["keyframes"], duration: VEO_DUR, audio: true, resolutions: ["720p", "1080p"] },
  { id: "fal-ai/veo3.1/first-last-frame-to-video", label: "Veo 3.1 Standard", family: "Veo 3.1", modes: ["keyframes"], duration: VEO_DUR, audio: true, resolutions: ["720p", "1080p"] },

  // ─── Veo 3.1 DIRECT (Google API via your GEMINI_API_KEY) — fixed 8s, native audio ───
  // One id serves text/image/keyframes; the runner infers the mode from the
  // connected start/end frames. Standard goes up to 4k; Fast (Lite) caps at 1080p.
  { id: "google/veo-3.1-generate-preview", label: "Veo 3.1 (direct)", family: "Veo 3.1", modes: ["text", "image", "keyframes"], duration: { kind: "enum", values: [8], default: 8 }, audio: true, resolutions: ["720p", "1080p", "4k"], recommended: true },
  { id: "google/veo-3.1-fast-generate-preview", label: "Veo 3.1 Fast (direct)", family: "Veo 3.1", modes: ["text", "image", "keyframes"], duration: { kind: "enum", values: [8], default: 8 }, audio: true, resolutions: ["720p", "1080p"] },

  // ─── Older / budget models ───
  { id: "fal-ai/kling-video/v2.5-turbo/pro/text-to-video", label: "Kling 2.5 Turbo Pro", family: "Other", modes: ["text"], duration: DUR_5_10 },
  { id: "fal-ai/kling-video/v2.1/master/text-to-video", label: "Kling 2.1 Master", family: "Other", modes: ["text"], duration: DUR_5_10 },
  { id: "fal-ai/kling-video/v2.1/master/image-to-video", label: "Kling 2.1 Master", family: "Other", modes: ["image"], duration: DUR_5_10 },
  { id: "fal-ai/kling-video/v2.1/pro/image-to-video", label: "Kling 2.1 Pro", family: "Other", modes: ["image"], duration: DUR_5_10 },
  { id: "fal-ai/minimax/hailuo-02/standard/image-to-video", label: "Hailuo 02", family: "Other", modes: ["image"], duration: { kind: "enum", values: [6, 10], default: 6 } },
  { id: "fal-ai/luma-dream-machine/ray-2/image-to-video", label: "Ray 2", family: "Other", modes: ["image"], duration: { kind: "enum", values: [5, 9], default: 5 } },
  { id: "fal-ai/pixverse/v6/image-to-video", label: "Pixverse V6", family: "Other", modes: ["image"], duration: { kind: "enum", values: [5, 8], default: 5 } },
];

export const VIDEO_MODE_LABELS: { value: VideoMode; label: string; hint: string }[] = [
  { value: "text", label: "Text → Video", hint: "Prompt only" },
  { value: "image", label: "Image → Video", hint: "Animate one start frame" },
  { value: "keyframes", label: "Keyframes", hint: "Start + end frame transition" },
  { value: "references", label: "References", hint: "Multiple reference images" },
  { value: "multi-shot", label: "Multi-shot", hint: "Several scenes in one video" },
  { value: "video-to-video", label: "Video → Video", hint: "Edit / restyle a source clip" },
];

const FAMILY_ORDER = ["Kling 3.0", "Seedance 2.0", "Veo 3.1", "Kling O3", "Kling O1", "Other"];

/** Models that serve a given mode, grouped by family in display order. */
export function modelsForMode(mode: VideoMode): { family: string; models: VideoModelDef[] }[] {
  const matching = VIDEO_MODELS.filter((m) => m.modes.includes(mode));
  const byFamily = new Map<string, VideoModelDef[]>();
  for (const m of matching) {
    if (!byFamily.has(m.family)) byFamily.set(m.family, []);
    byFamily.get(m.family)!.push(m);
  }
  return [...byFamily.entries()]
    .sort((a, b) => {
      const ia = FAMILY_ORDER.indexOf(a[0]); const ib = FAMILY_ORDER.indexOf(b[0]);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    })
    .map(([family, models]) => ({ family, models }));
}

export function getVideoModel(id: string): VideoModelDef | undefined {
  return VIDEO_MODELS.find((m) => m.id === id);
}

/** Best default model for a mode (first recommended, else first available). */
export function defaultModelForMode(mode: VideoMode): string {
  const matching = VIDEO_MODELS.filter((m) => m.modes.includes(mode));
  return (matching.find((m) => m.recommended) ?? matching[0])?.id ?? "fal-ai/kling-video/v3/pro/image-to-video";
}

/** Clamp a duration to what a model supports. */
export function clampDuration(modelId: string, value: number): number {
  const m = getVideoModel(modelId);
  if (!m) return value;
  if (m.duration.kind === "range") {
    const { min, max, step } = m.duration;
    const snapped = Math.round((value - min) / step) * step + min;
    return Math.max(min, Math.min(max, snapped));
  }
  // enum — nearest allowed value
  return m.duration.values.reduce((best, v) => (Math.abs(v - value) < Math.abs(best - value) ? v : best), m.duration.values[0]);
}
