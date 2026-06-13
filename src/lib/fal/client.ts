// Server-side fal.ai client.
// Uses up to 2 API keys with simple round-robin to avoid one-key throttling.
// Keys are read from env vars FAL_API_KEY_1 and FAL_API_KEY_2 (set in Vercel).

import { isVisionCapable, requiresReasoning } from "@/lib/canvas/types";

let _keyIndex = 0;

export function getFalKeys(): string[] {
  const keys = [process.env.FAL_API_KEY_1, process.env.FAL_API_KEY_2].filter(
    (k): k is string => !!k && k.trim().length > 0,
  );
  return keys;
}

export function nextFalKey(): string {
  const keys = getFalKeys();
  if (keys.length === 0) throw new Error("No fal.ai keys configured. Set FAL_API_KEY_1 (and optionally _2) in env.");
  const key = keys[_keyIndex % keys.length];
  _keyIndex++;
  return key;
}

/** Submit a request to fal.ai queue. Returns request_id. */
export async function falSubmit(
  modelId: string,
  input: Record<string, unknown>,
  apiKey?: string,
): Promise<{ request_id: string; apiKey: string }> {
  const key = apiKey ?? nextFalKey();
  const res = await fetch(`https://queue.fal.run/${modelId}`, {
    method: "POST",
    headers: { Authorization: `Key ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`fal.ai submit ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = (await res.json()) as { request_id?: string };
  if (!data.request_id) throw new Error("No request_id in fal.ai response");
  return { request_id: data.request_id, apiKey: key };
}

/** Poll status — returns the parsed status object */
export async function falStatus(
  modelId: string,
  requestId: string,
  apiKey: string,
): Promise<{ status: "IN_QUEUE" | "IN_PROGRESS" | "COMPLETED" | "FAILED"; logs?: unknown }> {
  const baseModel = modelId.split("/").slice(0, 2).join("/");
  const res = await fetch(`https://queue.fal.run/${baseModel}/requests/${requestId}/status`, {
    headers: { Authorization: `Key ${apiKey}` },
  });
  if (!res.ok) throw new Error(`fal.ai status ${res.status}`);
  return (await res.json()) as never;
}

/** Fetch result after status === 'COMPLETED' */
export async function falResult(
  modelId: string,
  requestId: string,
  apiKey: string,
): Promise<Record<string, unknown>> {
  const baseModel = modelId.split("/").slice(0, 2).join("/");
  const res = await fetch(`https://queue.fal.run/${baseModel}/requests/${requestId}`, {
    headers: { Authorization: `Key ${apiKey}` },
  });
  if (!res.ok) throw new Error(`fal.ai result ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

/** Synchronously run a model end-to-end with internal polling. */
export async function falRun(
  modelId: string,
  input: Record<string, unknown>,
  opts: { onProgress?: (s: string) => void; timeoutMs?: number; apiKey?: string } = {},
): Promise<Record<string, unknown>> {
  const { request_id, apiKey } = await falSubmit(modelId, input, opts.apiKey);
  opts.onProgress?.("submitted");

  const timeout = opts.timeoutMs ?? 600_000; // 10 minutes
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    await new Promise((r) => setTimeout(r, 2000));
    const s = await falStatus(modelId, request_id, apiKey);
    opts.onProgress?.(s.status);
    if (s.status === "COMPLETED") {
      return await falResult(modelId, request_id, apiKey);
    }
    if (s.status === "FAILED") {
      // Try to pull a human-readable error out of fal's response. The
      // useful info is usually nested in `logs[].message` or a top-level
      // `error` field; otherwise we fall back to the whole blob.
      let msg = "";
      const blob = s as unknown as { logs?: Array<{ message?: string }>; error?: string };
      if (Array.isArray(blob.logs)) {
        const lastErr = [...blob.logs].reverse().find((l) => l.message);
        if (lastErr?.message) msg = lastErr.message;
      }
      if (!msg && blob.error) msg = blob.error;
      if (!msg) msg = JSON.stringify(s).slice(0, 300);
      throw new Error(`fal.ai job failed: ${msg.slice(0, 400)}`);
    }
  }
  throw new Error(`fal.ai timeout after ${timeout}ms`);
}

/** Call OpenRouter via fal.ai for text or vision LLM completion.
 *
 *  fal exposes THREE different OpenRouter wrappers — we use the two
 *  native ones (NOT the OpenAI-compat path which has its own quirks):
 *
 *  1. TEXT wrapper at `https://fal.run/openrouter/router`
 *     - Schema: { prompt, model, system_prompt?, temperature? } → { output }
 *     - Documented models: Claude (opus-4.6, sonnet-4.6, sonnet-4.5),
 *       GPT-4.1, GPT OSS, Gemini, Llama 4, Kimi K2.5.
 *
 *  2. VISION wrapper at `https://fal.run/openrouter/router/vision`
 *     - Schema: { image_urls: [], prompt, model, system_prompt?, temperature? } → { output }
 *     - Documented models: Claude Sonnet (4.6/4.5, NOT Opus), GPT-4o,
 *       Gemini, Kimi K2.5, Qwen3-VL, Grok-4-fast.
 *
 *  Routing rule: no images → text wrapper. Images present + user picked
 *  a vision-capable model → vision wrapper with that model. Images
 *  present + user picked a text-only model (e.g. Claude Opus) → vision
 *  wrapper with Claude Sonnet 4.6 as fallback (with info log). */
export async function falLLM(
  prompt: string,
  // Default = Claude Opus 4.6 — top text model on fal-OR. For workflows
  // with vision the runner-side fallback to claude-sonnet-4.6 kicks in
  // automatically when images are wired to the node.
  model = "anthropic/claude-opus-4.6",
  temperature = 0.7,
  imageUrls?: string | string[],
  systemPrompt?: string,
): Promise<string> {
  // Cap the number of images per vision call. Brand kits can hold dozens of
  // UI screenshots; sending them all makes the OpenRouter vision wrapper reject
  // the request with a 400 "Provider returned error". 6 is plenty of context.
  const MAX_VISION_IMAGES = 6;
  const allImages = (Array.isArray(imageUrls) ? imageUrls : imageUrls ? [imageUrls] : [])
    .filter((u): u is string => typeof u === "string" && u.length > 0);
  const images = allImages.slice(0, MAX_VISION_IMAGES);
  if (allImages.length > MAX_VISION_IMAGES) {
    console.info(`[falLLM] ${allImages.length} images supplied; using first ${MAX_VISION_IMAGES} for the vision call.`);
  }

  if (images.length === 0) {
    return falLLMText(prompt, model, temperature, systemPrompt);
  }

  // Vision request. Use the user's model if it's vision-capable on
  // fal-OR's vision wrapper — otherwise fall back to a known-good
  // vision Claude. The list of vision-capable models is sourced from
  // fal vision wrapper docs (see LLM_MODELS.vision in types.ts).
  const visionFallback = "anthropic/claude-sonnet-4.6";
  let visionModel = model;
  if (!isVisionCapable(model)) {
    visionModel = visionFallback;
    console.info(
      `[falLLM] Vision request with ${images.length} image(s). "${model}" isn't ` +
      `documented as vision-capable on fal-OR — switching to "${visionFallback}" ` +
      `for this call. (Models marked "vision: true" in LLM_MODELS are preserved.)`,
    );
  }

  // If the vision wrapper rejects the request (provider error, a bad/expired
  // image URL, an unsupported format, etc.), don't fail the whole node — the
  // images are auxiliary context for a TEXT deliverable. Retry text-only so the
  // user still gets a script/voiceover instead of a red error node.
  try {
    return await falLLMVision(prompt, visionModel, images, temperature, systemPrompt);
  } catch (e) {
    console.warn(`[falLLM] Vision call failed (${e instanceof Error ? e.message : "unknown"}); retrying text-only without images.`);
    return falLLMText(prompt, model, temperature, systemPrompt);
  }
}

/** Text-only LLM call via fal's openrouter/router wrapper.
 *  Simple schema: prompt + model + optional system_prompt + temperature.
 *  Returns the `output` field directly. */
async function falLLMText(
  prompt: string,
  model: string,
  temperature: number,
  systemPrompt?: string,
): Promise<string> {
  const key = nextFalKey();

  const body: Record<string, unknown> = { prompt, model };
  if (systemPrompt && systemPrompt.trim()) body.system_prompt = systemPrompt;
  if (typeof temperature === "number" && temperature !== 1) {
    body.temperature = temperature;
  }
  // Reasoning models (gpt-oss-120b, gemini-3.x-preview) reject the request
  // with 400 "Reasoning is mandatory and cannot be disabled" unless we
  // explicitly send reasoning:true.
  if (requiresReasoning(model)) body.reasoning = true;

  const res = await fetch("https://fal.run/openrouter/router", {
    method: "POST",
    headers: {
      Authorization: `Key ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`fal/openrouter ${res.status}: ${text.slice(0, 400)}`);
  }

  const data = (await res.json()) as { output?: string; error?: string };
  if (data.error) throw new Error(`fal/openrouter: ${data.error}`);
  return data.output ?? "";
}

/** Vision LLM call via fal's openrouter/router/vision wrapper.
 *  Native schema for images: { image_urls: list<string>, prompt, model,
 *  system_prompt?, temperature? } → { output }.
 *  Supports multiple images natively in one call. */
async function falLLMVision(
  prompt: string,
  model: string,
  images: string[],
  temperature: number,
  systemPrompt?: string,
): Promise<string> {
  const key = nextFalKey();

  const body: Record<string, unknown> = {
    image_urls: images,
    prompt,
    model,
  };
  if (systemPrompt && systemPrompt.trim()) body.system_prompt = systemPrompt;
  if (typeof temperature === "number" && temperature !== 1) {
    body.temperature = temperature;
  }
  if (requiresReasoning(model)) body.reasoning = true;

  const res = await fetch("https://fal.run/openrouter/router/vision", {
    method: "POST",
    headers: {
      Authorization: `Key ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`fal/openrouter vision ${res.status}: ${text.slice(0, 400)}`);
  }

  const data = (await res.json()) as { output?: string; error?: string };
  if (data.error) throw new Error(`fal/openrouter vision: ${data.error}`);
  return data.output ?? "";
}

// ─────────────────────────────────────────────
// Cost estimation — rough per-model pricing in USD.
// Values are approximations; used only for display.
// ─────────────────────────────────────────────
export function estimateCost(modelId: string, params: { duration?: number; numImages?: number } = {}): number {
  const id = modelId.toLowerCase();
  const numImg = params.numImages ?? 1;
  const dur = params.duration ?? 1;

  if (id.includes("flux/schnell")) return 0.003 * numImg;
  if (id.includes("flux/dev")) return 0.025 * numImg;
  if (id.includes("flux-pro/v1.1-ultra")) return 0.06 * numImg;
  if (id.includes("flux-pro/v1.1")) return 0.04 * numImg;
  if (id.includes("flux-pro/kontext/max")) return 0.08 * numImg;
  if (id.includes("flux-pro/kontext")) return 0.04 * numImg;
  if (id.includes("nano-banana")) return 0.039 * numImg;
  if (id.includes("imagen4")) return 0.04 * numImg;
  if (id.includes("recraft")) return 0.04 * numImg;
  if (id.includes("ideogram")) return 0.04 * numImg;
  if (id.includes("stable-diffusion")) return 0.025 * numImg;

  // Kling pricing varies a lot by tier (per fal.ai docs). Approximate
  // values, biased slightly high so we don't undercount in budgets:
  //   4k:           $0.42/s flat (regardless of audio)
  //   master:       $0.42/s (V2.1 master)
  //   pro:          ~$0.11-0.17/s (depends on audio + V3 voice control)
  //   standard:     ~$0.08-0.13/s
  //   unspecified:  fallback used for older listed models
  if (id.includes("kling-video") && id.includes("/4k/")) return 0.42 * dur;
  if (id.includes("kling-video") && id.includes("master")) return 0.42 * dur;
  if (id.includes("kling-video") && id.includes("/pro/")) return 0.17 * dur;
  if (id.includes("kling-video") && id.includes("/standard/")) return 0.12 * dur;
  if (id.includes("kling-video")) return 0.20 * dur;
  if (id.includes("veo3")) return 0.5 * dur;
  if (id.includes("runway-gen3")) return 0.5 * dur;
  if (id.includes("hailuo")) return 0.25 * dur;
  if (id.includes("luma-dream")) return 0.18 * dur;

  if (id.includes("sync-lipsync") || id.includes("latentsync")) return 0.1;

  if (id.includes("elevenlabs/tts")) return 0.0001 * 100; // ~$0.01 per 1000 chars
  if (id.includes("elevenlabs/sound-effects")) return 0.02 * dur;
  if (id.includes("stable-audio") || id.includes("cassetteai")) return 0.01 * dur;

  if (id.includes("any-llm")) return 0.001;
  if (id.includes("birefnet") || id.includes("rembg")) return 0.005;
  if (id.includes("upscaler") || id.includes("aura-sr") || id.includes("ccsr")) return 0.04;
  if (id.includes("face-swap") || id.includes("photomaker")) return 0.05;

  return 0.01; // default
}
