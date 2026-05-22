// Server-side fal.ai client.
// Uses up to 2 API keys with simple round-robin to avoid one-key throttling.
// Keys are read from env vars FAL_API_KEY_1 and FAL_API_KEY_2 (set in Vercel).

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
      throw new Error(`fal.ai job failed: ${JSON.stringify(s).slice(0, 300)}`);
    }
  }
  throw new Error(`fal.ai timeout after ${timeout}ms`);
}

/** Call OpenRouter via fal.ai for text completion. Replaces deprecated fal-ai/any-llm.
 *  Uses OpenAI-compatible chat completions API at https://fal.run/openrouter/router/openai/v1
 *  All major models available: claude-opus-4-7, gpt-5.5, gemini-3-pro, deepseek-v4, llama-4, etc. */
export async function falLLM(
  prompt: string,
  model = "anthropic/claude-haiku-latest",
  temperature = 0.7,
  // Pass either a single image URL (legacy callers) or an array (multi-image
  // vision — Claude/GPT/Gemini all support multiple image_url content blocks
  // in a single user turn). Empty array or undefined = text-only.
  imageUrls?: string | string[],
  systemPrompt?: string,
): Promise<string> {
  const key = nextFalKey();

  // Normalise to array, filter out empty strings (which would otherwise become
  // broken image_url content blocks and fail the request).
  const images = (Array.isArray(imageUrls) ? imageUrls : imageUrls ? [imageUrls] : [])
    .filter((u): u is string => typeof u === "string" && u.length > 0);

  // Build messages — OpenAI chat format. Vision models support image content
  // blocks; non-vision models receive text-only and ignore images silently.
  const userContent: unknown =
    images.length > 0
      ? [
          { type: "text", text: prompt },
          ...images.map((url) => ({ type: "image_url", image_url: { url } })),
        ]
      : prompt;

  const messages: Array<{ role: string; content: unknown }> = [];
  if (systemPrompt && systemPrompt.trim()) {
    messages.push({ role: "system", content: systemPrompt });
  }
  messages.push({ role: "user", content: userContent });

  const body = {
    model,
    messages,
    temperature,
  };

  const res = await fetch("https://fal.run/openrouter/router/openai/v1/chat/completions", {
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

  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  return data.choices?.[0]?.message?.content ?? "";
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

  if (id.includes("kling-video") && id.includes("master")) return 0.42 * dur;
  if (id.includes("kling-video")) return 0.28 * dur;
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
