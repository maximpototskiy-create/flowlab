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

/** Call OpenRouter via fal.ai for text completion.
 *  Splits into two paths because fal exposes TWO different OpenRouter wrappers:
 *
 *  1. NATIVE wrapper at `https://fal.run/openrouter/router`
 *     - Schema: { prompt, model, system_prompt?, temperature?, max_tokens? } → { output }
 *     - Documented models: Claude (sonnet-4.6, opus-4.6, sonnet-4.5),
 *       GPT-4.1, Gemini 2.5 Flash, Llama 4, Kimi K2.5, GPT OSS.
 *     - Single-turn only (no `messages` array, no vision).
 *
 *  2. OPENAI-COMPAT wrapper at `https://fal.run/openrouter/router/openai/v1/chat/completions`
 *     - Schema: standard OpenAI chat completions (messages array, image_url blocks).
 *     - Officially documented ONLY with `google/gemini-2.5-flash` — accepts
 *       Gemini models reliably. With Claude/etc IDs, silently falls back to
 *       openai/gpt-* (this is the bug Maxim saw: he requested Claude in
 *       textGen, fal dashboard showed his calls as $0.022/10s = GPT pricing,
 *       not Claude).
 *
 *  Routing rule: text-only → native wrapper, vision → OpenAI-compat with
 *  Gemini forced. If user picked Claude but added images, we log that we're
 *  forcing Gemini (because vision on this path only reliably works with
 *  Gemini). */
export async function falLLM(
  prompt: string,
  // Default = Claude Opus 4.6 (concrete slug, documented working on native
  // wrapper). We had `~anthropic/claude-opus-latest` briefly but tilde-
  // aliases aren't documented on fal's wrapper and turned out to also fall
  // back. Concrete IDs from fal's published example list are the safe bet.
  model = "anthropic/claude-opus-4.6",
  temperature = 0.7,
  imageUrls?: string | string[],
  systemPrompt?: string,
): Promise<string> {
  // Normalise images list. Empty array or no URLs = text path.
  const images = (Array.isArray(imageUrls) ? imageUrls : imageUrls ? [imageUrls] : [])
    .filter((u): u is string => typeof u === "string" && u.length > 0);

  if (images.length === 0) {
    return falLLMText(prompt, model, temperature, systemPrompt);
  }

  // Vision path. We must use OpenAI-compat endpoint (only one with image
  // support), and the only model family that reliably accepts vision
  // there is Gemini. If the user explicitly picked a non-Gemini model,
  // tell them in console that we're overriding for this call.
  const visionModel = "google/gemini-2.5-flash";
  if (!model.toLowerCase().includes("google/gemini")) {
    console.info(
      `[falLLM] Vision request with ${images.length} image(s). User picked "${model}" ` +
      `but fal's OpenRouter wrapper only reliably handles vision via Gemini — ` +
      `forcing "${visionModel}" for this call.`,
    );
  }
  return falLLMVision(prompt, visionModel, images, temperature, systemPrompt);
}

/** Text-only LLM call via fal's NATIVE openrouter/router wrapper.
 *  This endpoint is properly documented with Claude/GPT/Gemini/etc and
 *  doesn't silent-fallback. Pass `model` as the OpenRouter slug. */
async function falLLMText(
  prompt: string,
  model: string,
  temperature: number,
  systemPrompt?: string,
): Promise<string> {
  const key = nextFalKey();

  const body: Record<string, unknown> = { prompt, model };
  if (systemPrompt && systemPrompt.trim()) body.system_prompt = systemPrompt;
  // fal's wrapper defaults temperature to 1; only send when user-overridden
  // (any value other than the OpenRouter default of 1).
  if (typeof temperature === "number" && temperature !== 1) {
    body.temperature = temperature;
  }

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

  const data = (await res.json()) as {
    output?: string;
    error?: string;
    // Native wrapper response doesn't echo `model` per docs — no mismatch
    // detection possible here. Bug we hit before (silent fallback on
    // OpenAI-compat path) shouldn't happen on this path since Claude is
    // explicitly documented as supported.
  };

  if (data.error) {
    throw new Error(`fal/openrouter: ${data.error}`);
  }
  return data.output ?? "";
}

/** Vision LLM call via fal's OpenAI-compat wrapper.
 *  Always uses Gemini — the only model family that reliably handles vision
 *  through this endpoint. Caller is responsible for telling the user when
 *  their selected model is being overridden. */
async function falLLMVision(
  prompt: string,
  model: string, // forced to Gemini by caller
  images: string[],
  temperature: number,
  systemPrompt?: string,
): Promise<string> {
  const key = nextFalKey();

  const userContent = [
    { type: "text", text: prompt },
    ...images.map((url) => ({ type: "image_url", image_url: { url } })),
  ];

  const messages: Array<{ role: string; content: unknown }> = [];
  if (systemPrompt && systemPrompt.trim()) {
    messages.push({ role: "system", content: systemPrompt });
  }
  messages.push({ role: "user", content: userContent });

  const body = { model, messages, temperature };

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
    throw new Error(`fal/openrouter vision ${res.status}: ${text.slice(0, 400)}`);
  }

  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
    model?: string;
  };

  // On vision path we DO want mismatch detection — if Gemini was requested
  // and OpenAI replied, that's a silent fallback we should know about.
  if (data.model && data.model !== model) {
    const requestedAuthor = model.split("/")[0]?.toLowerCase();
    const servedAuthor = data.model.split("/")[0]?.toLowerCase();
    if (requestedAuthor !== servedAuthor) {
      console.warn(
        `[falLLM:vision] Model mismatch: requested "${model}" but fal served "${data.model}". ` +
        `Vision path silent fallback — investigate.`,
      );
    }
  }

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
