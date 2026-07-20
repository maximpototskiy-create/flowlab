// ─── TEMPORARY: direct Google routing disabled (key rotation) ───────────────
// Nano Banana and Veo direct calls (corporate GEMINI_API_KEY) and the Gemini
// choice in the canvas agent are rerouted through fal until the NEW Google
// API key lands. TO REVERT: set DIRECT_GOOGLE_DISABLED = false - nothing else
// to touch; saved workflows keep their google/* model ids and will resume
// using the direct path automatically.
export const DIRECT_GOOGLE_DISABLED = true;

/** Image models: google-direct id -> fal equivalent (refs switch to /edit). */
export function remapDirectImageModel(model: string, hasRefs: boolean): string {
  if (!DIRECT_GOOGLE_DISABLED || !model.startsWith("google/")) return model;
  if (model.includes("gemini-3-pro-image")) return hasRefs ? "fal-ai/nano-banana-pro/edit" : "fal-ai/nano-banana-pro";
  if (model.includes("imagen-4.0-ultra")) return "fal-ai/imagen4/preview/ultra";
  if (model.includes("imagen-4.0")) return "fal-ai/imagen4/preview";
  // gemini-3.1-flash-image and anything else -> Nano Banana 2 on fal
  return hasRefs ? "fal-ai/nano-banana-2/edit" : "fal-ai/nano-banana-2";
}

/** Veo direct -> fal Veo 3.1, endpoint picked from the connected frames. */
export function remapDirectVeoModel(model: string, hasStart: boolean, hasEnd: boolean): string {
  if (!DIRECT_GOOGLE_DISABLED || !model.startsWith("google/veo")) return model;
  const base = model.includes("fast") ? "fal-ai/veo3.1/fast" : "fal-ai/veo3.1";
  if (hasStart && hasEnd) return `${base}/first-last-frame-to-video`;
  if (hasStart) return `${base}/image-to-video`;
  return base;
}

/** Canvas agent: Gemini picks fall back to Claude while the key is rotated. */
export function remapAgentModel(model: string): string {
  if (!DIRECT_GOOGLE_DISABLED) return model;
  return model.startsWith("gemini") || model.startsWith("google/") ? "anthropic/claude-sonnet-4.6" : model;
}
