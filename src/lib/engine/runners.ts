// Server-side node execution.
// Each runner takes resolved inputs + config and returns outputs.
// Generated assets are uploaded to Supabase Storage and recorded in DB.

import { falLLM, falRun, estimateCost } from "@/lib/fal/client";
import { createVideoFromPrompt, pollVideo, createAvatarVideo, pollVideoStatus, createAvatarIVVideo } from "@/lib/heygen/client";
import { getSystemPrompt } from "./systemPrompts";
import { uploadFromUrl, uploadBytes, buildStoragePath, extFromUrl, kindFromMime } from "@/lib/storage";
import { compositeGreenScreen } from "@/lib/video";
import { directLLM } from "@/lib/agent/router";
import { generateOpenAIImage, editOpenAIImage } from "@/lib/openai/images";
import { generateGeminiImage, generateImagen } from "@/lib/google/images";
import { isDirectLLM } from "@/lib/canvas/types";

// Route first-party OpenAI/Gemini node models through the user's own keys
// (direct API); everything else (Anthropic, OSS, etc.) stays on fal's LLM
// endpoint. Same signature as falLLM so call sites just swap the name.
async function llmCall(
  prompt: string,
  model: string,
  temperature: number,
  images: string[],
  systemPrompt?: string,
): Promise<string> {
  if (isDirectLLM(model)) return directLLM(model, prompt, images, systemPrompt);
  return falLLM(prompt, model, temperature, images, systemPrompt);
}

export type RunnerContext = {
  brandId?: string | null;
  projectId?: string | null;
  workflowId?: string;
  runStepId?: string;
  /** Brand kit context for LLM nodes — appended to prompts when "Apply Brand Voice" was used */
  brandVoice?: string;
  /** Brand UI screenshots (CDN URLs) auto-attached to LLM vision calls and
   *  imageGen reference inputs. Lets the model SEE the actual app UI when
   *  generating prompts/copy/visuals for it, without the user having to
   *  manually add Upload Image nodes for the same screenshots in every
   *  workflow. The Brand Assets canvas node provides explicit per-node
   *  control when needed. */
  brandUiScreenshots?: string[];
};

export type RunnerResult = {
  outputs: Record<string, unknown>;
  /** For multi-result nodes (image batch generation), individual results */
  results?: { value: string; mime?: string }[];
  costUsd: number;
  durationMs: number;
  metadata?: Record<string, unknown>;
};

const ASPECT_TO_SIZE: Record<string, string> = {
  "1:1": "square_hd",
  "9:16": "portrait_16_9",
  "16:9": "landscape_16_9",
  "4:5": "portrait_4_3",
  "3:4": "portrait_4_3",
};

// GPT Image 2 (direct OpenAI) sizes — arbitrary WIDTHxHEIGHT, both divisible
// by 16, aspect ratio between 1:3 and 3:1.
const ASPECT_TO_OPENAI_SIZE: Record<string, string> = {
  "1:1": "1024x1024",
  "16:9": "1536x864",
  "9:16": "864x1536",
  "4:5": "1024x1280",
  "3:4": "1152x1536",
};

/** Helper: store a fal.ai result URL in Supabase Storage; on failure, return the original URL. */
async function persistAsset(remoteUrl: string, ctx: RunnerContext, prefix = "asset"): Promise<string> {
  const ext = extFromUrl(remoteUrl);
  const path = buildStoragePath({
    brandId: ctx.brandId,
    projectId: ctx.projectId,
    workflowId: ctx.workflowId,
    runStepId: ctx.runStepId,
    prefix,
    ext,
  });
  try {
    const { cdnUrl } = await uploadFromUrl(remoteUrl, path);
    if (cdnUrl) {
      console.log(`[persistAsset] saved ${path} → ${cdnUrl.slice(0, 80)}…`);
      return cdnUrl;
    }
    console.warn(`[persistAsset] uploadFromUrl returned empty cdnUrl for ${path}, falling back to remote URL`);
    return remoteUrl;
  } catch (err) {
    // Storage might be misconfigured (bucket not created, missing service role key, etc).
    // Don't fail the whole run — fal.ai URLs work for ~24h, which is enough for the user
    // to see and download the result. Log warning but continue.
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[persistAsset] STORAGE FAILED for ${path}: ${msg}`);
    return remoteUrl;
  }
}

/** Persist a base64-encoded image (from a direct OpenAI image call) to Supabase
 *  Storage and return its CDN URL. GPT Image output is PNG. */
async function persistImageB64(b64: string, ctx: RunnerContext, prefix = "img"): Promise<string> {
  const buf = Buffer.from(b64, "base64");
  const path = buildStoragePath({
    brandId: ctx.brandId,
    projectId: ctx.projectId,
    workflowId: ctx.workflowId,
    runStepId: ctx.runStepId,
    prefix,
    ext: "png",
  });
  const { cdnUrl } = await uploadBytes(buf, path, "image/png");
  return cdnUrl;
}

/** Run N image-generating calls concurrently, tolerating partial failures
 *  (e.g. provider rate limits) so the user still gets whatever succeeded.
 *  Logs requested-vs-succeeded for diagnosis. Throws only if ALL calls fail. */
async function gatherImages(
  label: string,
  count: number,
  make: () => Promise<string[]>,
  concurrency = 2,
): Promise<string[]> {
  const out: string[] = [];
  const errs: string[] = [];
  let next = 0;
  async function worker() {
    while (next < count) {
      next++;
      try {
        out.push(...(await make()));
      } catch (e) {
        errs.push(e instanceof Error ? e.message : String(e));
      }
    }
  }
  // Cap parallelism to avoid provider rate limits (429); the image clients also
  // retry 429/5xx with backoff, so throttled calls still land.
  await Promise.all(Array.from({ length: Math.min(concurrency, count) }, () => worker()));
  console.log(
    `[imageGen/${label}] requested ${count} call(s) -> ${out.length} image(s)` +
      (errs.length ? `; ${errs.length} failed (first: ${errs[0]})` : ""),
  );
  if (out.length === 0) throw new Error(errs[0] || "No images returned");
  return out;
}

/** Helper: normalise an `images` multi-port input into a clean string[] of
 * URLs. Accepts the new array form (post-multi-port runtime), the legacy
 * `inputs.image` single-string form (workflows saved before multi-ports
 * existed), and ignores anything that isn't a usable HTTP(S) URL. */
function collectImages(inputs: Record<string, unknown>): string[] {
  const out: string[] = [];
  const arr = inputs.images;
  if (Array.isArray(arr)) {
    for (const v of arr) if (typeof v === "string" && v) out.push(v);
  }
  // Legacy single-image port name — backwards compat with older saved graphs.
  const single = inputs.image;
  if (typeof single === "string" && single) out.push(single);
  // De-duplicate (in case the same upstream node is referenced twice somehow).
  return [...new Set(out)];
}

export async function runNode(
  type: string,
  config: Record<string, unknown>,
  inputs: Record<string, unknown>,
  ctx: RunnerContext,
): Promise<RunnerResult> {
  const t0 = Date.now();

  switch (type) {
    // ─────────────────────── TEXT
    case "yourText":
      return { outputs: { text: String(config.text ?? "") }, costUsd: 0, durationMs: Date.now() - t0 };

    case "textGen":
    case "creativeBrief":
    case "imageAdPrompt":
    case "adVariation":
    case "videoScript":
    case "videoFramePrompt":
    case "videoAdPrompt":
    case "voiceoverScript":
    case "musicPrompt":
    case "characterPrompt": {
      const instructions = String(config.instructions ?? "");
      const model = String(config.model ?? "anthropic/claude-sonnet-4.6");
      const temperature = Number(config.temperature ?? 0.7);
      const context = inputs.context as string | undefined;
      // Multi-image input — array (possibly empty) from the multi-port.
      // Also accepts legacy `inputs.image` (single string) for backwards
      // compatibility with workflows saved before the multi-port was added.
      const userImages = collectImages(inputs);
      // Auto-attach brand kit (screenshots AND voice text) ONLY when:
      //   1. user hasn't wired their own references AND
      //   2. "Use brand kit" toggle is on (default true; old nodes lacking
      //      the field also default true for backwards compatibility).
      const useBrandKit = config.useBrandKit !== false;
      const brandImages =
        useBrandKit && userImages.length === 0
          ? (ctx.brandUiScreenshots ?? [])
          : [];
      const images = [...userImages, ...brandImages];
      const brandSuffix =
        useBrandKit && ctx.brandVoice ? `\n\nBrand voice:\n${ctx.brandVoice}` : "";
      // Defense-in-depth: even with system prompt, some models still drift into
      // preambles when the user input is conversational ("напиши промпт..."). 
      // Adding an explicit final reminder at the END of the user message
      // dramatically improves adherence — models attend to recent tokens more.
      const formatReminder =
        "\n\n---\nOUTPUT FORMAT: Begin your response with the FIRST WORD of the deliverable. No preamble. No headers like '**КОНЦЕПТ**' or '---'. No closing remarks. If multiple items, separate with one blank line only.";
      const prompt = context
        ? `Context:\n${context}\n\nTask:\n${instructions}${brandSuffix}${formatReminder}`
        : `${instructions}${brandSuffix}${formatReminder}`;
      const systemPrompt = getSystemPrompt(type);
      const text = await llmCall(prompt, model, temperature, images, systemPrompt);
      return {
        outputs: { text },
        costUsd: estimateCost("any-llm"),
        durationMs: Date.now() - t0,
      };
    }

    case "adAnalysis": {
      const instructions = String(config.instructions ?? "");
      const model = String(config.model ?? "anthropic/claude-opus-4.6");
      const temperature = Number(config.temperature ?? 0.4);
      const description = inputs.description as string | undefined;
      const images = collectImages(inputs);
      const parts = [instructions];
      if (description) parts.push(`Description: ${description}`);
      const systemPrompt = getSystemPrompt("adAnalysis");
      const text = await llmCall(parts.join("\n\n"), model, temperature, images, systemPrompt);
      return { outputs: { analysis: text }, costUsd: estimateCost("any-llm"), durationMs: Date.now() - t0 };
    }

    // ─────────────────────── IMAGE
    case "imageGen": {
      const rawPrompt = String(config.instructions || inputs.prompt || "").trim();
      if (!rawPrompt) throw new Error("Provide a prompt (input or instructions)");
      // Any text rendered INTO the image must be English, even if the prompt
      // itself is written in another language (e.g. Russian instructions).
      const prompt = `${rawPrompt}\n\nIMPORTANT: Any text, labels, or copy rendered inside the image must be written in English only — never in the language of this prompt.`;
      let model = String(config.model ?? "fal-ai/flux/dev");
      const aspect = String(config.aspect ?? "1:1");
      const numResults = Math.max(1, Math.min(4, Number(config.num_results ?? 1)));

      // Multimodal: collect any reference images connected to the multi-port.
      // Also accept the legacy single `inputs.image` for older workflows. We
      // cap at 14 — Nano Banana 2 edit's documented max — and silently drop
      // extras to avoid 4xx from fal.ai.
      const userRefs = collectImages(inputs);
      // Auto-attach brand UI screenshots as references — UNLESS:
      //   1. user already wired explicit references upstream (multi-port
      //      has values), OR
      //   2. user disabled "Use brand kit" toggle on this node.
      // For old workflows without the toggle (config.useBrandKit undefined),
      // we default to TRUE so behaviour matches what was working before.
      const useBrandKit = config.useBrandKit !== false; // default true
      const brandRefs =
        useBrandKit && userRefs.length === 0
          ? (ctx.brandUiScreenshots ?? [])
          : [];
      const refImages = [...userRefs, ...brandRefs].slice(0, 14);
      const hasRefs = refImages.length > 0;

      // ─── Direct OpenAI image (GPT Image 2) ──────────────────────────
      // Routed through the user's own OPENAI_API_KEY (OpenAI Images API)
      // instead of fal. GPT Image returns base64, so we persist the bytes to
      // Storage ourselves. When refs are wired we use the /edit endpoint.
      if (model.startsWith("openai/")) {
        const apiModel = model.split("/").slice(1).join("/"); // e.g. "gpt-image-2"
        const size = ASPECT_TO_OPENAI_SIZE[aspect] ?? "1024x1024";
        const quality = String(config.quality || "medium");
        let b64s: string[];
        if (hasRefs) {
          b64s = await editOpenAIImage(prompt, refImages, { model: apiModel, size, quality });
        } else {
          // GPT Image 2 returns ONE image per call in practice (its "thinking"
          // pass produces a single reasoned image), so request N results as N
          // concurrent single-image calls. gatherImages tolerates partial
          // failures (rate limits) and logs the requested-vs-received count.
          b64s = await gatherImages("openai", numResults, () =>
            generateOpenAIImage(prompt, { model: apiModel, size, quality, n: 1 }),
          );
        }
        const persisted = await Promise.all(b64s.map((b64) => persistImageB64(b64, ctx, "img")));
        return {
          outputs: { image: persisted[0] },
          results: persisted.map((url) => ({ value: url, mime: "image/png" })),
          costUsd: estimateCost(model, { numImages: numResults }),
          durationMs: Date.now() - t0,
        };
      }

      // ─── Direct Google image (Nano Banana via Gemini, or Imagen) ────
      // Routed through the user's own GEMINI_API_KEY. Both return base64,
      // which we persist to Storage ourselves.
      if (model.startsWith("google/")) {
        const apiModel = model.split("/").slice(1).join("/");
        let b64s: string[];
        if (model.includes("imagen")) {
          // Imagen :predict — sampleCount up to 4 covers N in one call. Imagen
          // aspect ratios don't include 4:5, so fall back to 3:4 for it.
          const imagenAspect = aspect === "4:5" ? "3:4" : aspect;
          b64s = await generateImagen(prompt, { model: apiModel, aspect: imagenAspect, n: numResults });
        } else if (hasRefs) {
          // Nano Banana edit/compose: references go in as inline image parts.
          b64s = await generateGeminiImage(prompt, { model: apiModel, aspect, refImages });
        } else {
          // Nano Banana returns one image per call → N concurrent calls for N
          // results (tolerant of partial failures, logs the count).
          b64s = await gatherImages("gemini", numResults, () =>
            generateGeminiImage(prompt, { model: apiModel, aspect }),
          );
        }
        const persisted = await Promise.all(b64s.map((b64) => persistImageB64(b64, ctx, "img")));
        return {
          outputs: { image: persisted[0] },
          results: persisted.map((url) => ({ value: url, mime: "image/png" })),
          costUsd: estimateCost(model, { numImages: numResults }),
          durationMs: Date.now() - t0,
        };
      }

      // Auto-switch model family to its image-editing variant when reference
      // images are connected. Both Nano Banana 2 and Nano Banana Pro have
      // dedicated /edit endpoints that accept image_urls[] (multi reference).
      if (hasRefs) {
        if (model === "fal-ai/nano-banana-2") model = "fal-ai/nano-banana-2/edit";
        else if (model === "fal-ai/nano-banana-pro") model = "fal-ai/nano-banana-pro/edit";
        else if (model === "fal-ai/nano-banana") model = "fal-ai/nano-banana/edit";
        // Other model families (Flux/Imagen/Ideogram/Recraft) don't accept
        // multi-image inputs at this endpoint — we log a warning and ignore
        // the references rather than error out, since the user might be
        // experimenting and we don't want to burn fal.ai cost on a 4xx.
        else if (!model.includes("/edit") && !model.includes("kontext")) {
          console.warn(
            `[imageGen] model ${model} doesn't support reference images; ignoring ${refImages.length} ref(s)`,
          );
        }
      }

      // Build per-model input. Different model families take different fields.
      const input: Record<string, unknown> = { prompt };
      if (model.includes("nano-banana")) {
        // Nano Banana 2 / Pro (and their /edit variants): aspect_ratio is a
        // dedicated parameter — fixing the bug where aspect was silently
        // dropped on the client side. Docs:
        //   https://fal.ai/models/fal-ai/nano-banana-2/api
        // 15 supported ratios incl. 9:16, 16:9, 4:5, 3:4, 2:3, etc.
        input.aspect_ratio = aspect;
        input.num_images = numResults;
        // CRITICAL: by default Nano Banana sets `limit_generations: true`,
        // which DISCARDS our num_images request and forces output to 1 image.
        // Without this line, asking for 4 still returns 1 — silent failure.
        // See: https://fal.ai/models/fal-ai/nano-banana-2/api
        //   "Experimental parameter to limit the number of generations from
        //    each round of prompting to 1. Set to True to disregard any
        //    instructions in the prompt regarding the number of images."
        input.limit_generations = false;
        if (model.includes("/edit") && hasRefs) {
          input.image_urls = refImages;
        }
      } else if (model.includes("imagen4")) {
        // Imagen: aspect_ratio + num_images
        input.aspect_ratio = aspect;
        input.num_images = numResults;
      } else if (model.includes("ideogram") || model.includes("recraft") || model.includes("flux-2")) {
        // These use aspect_ratio
        input.aspect_ratio = aspect;
        input.num_images = numResults;
      } else if (model.includes("gpt-image")) {
        // OpenAI GPT Image (1/2) via fal: fal's standard named image_size +
        // quality tiers (low|medium|high). No aspect_ratio / safety_checker
        // fields — those would 4xx on the OpenAI-backed endpoint.
        input.image_size = ASPECT_TO_SIZE[aspect] ?? "square_hd";
        input.num_images = numResults;
        input.quality = String(config.quality || "high");
        if (model.includes("/edit") && hasRefs) input.image_urls = refImages;
      } else {
        // FLUX, SD 3.5, etc — use image_size
        input.image_size = ASPECT_TO_SIZE[aspect] ?? "square_hd";
        input.num_images = numResults;
        input.enable_safety_checker = false;
      }

      const r = await falRun(model, input);

      const images = (r.images as { url: string }[] | undefined) ?? [];
      if (images.length === 0) throw new Error("Model returned no images");

      const persisted: string[] = [];
      for (const img of images) {
        persisted.push(await persistAsset(img.url, ctx, "img"));
      }

      return {
        outputs: { image: persisted[0] },
        results: persisted.map((url) => ({ value: url, mime: "image/png" })),
        costUsd: estimateCost(model, { numImages: numResults }),
        durationMs: Date.now() - t0,
      };
    }

    case "imageResize": {
      const image = inputs.image as string;
      if (!image) throw new Error("Connect an image");
      const aspect = String(config.aspect ?? "9:16");
      const mode = String(config.mode ?? "outpaint");
      if (mode === "crop") {
        // For now: server-side crop is not implemented (would need sharp).
        // Pass through and rely on client-side crop where possible.
        // TODO: add sharp-based crop
        return { outputs: { image }, costUsd: 0, durationMs: Date.now() - t0 };
      }
      const r = await falRun("fal-ai/flux-pro/kontext", {
        image_url: image,
        prompt: `Extend the image to ${aspect} aspect ratio. ${
          config.instructions ?? "Keep style and composition natural."
        }`,
      });
      const url = ((r.images as { url: string }[] | undefined) ?? [])[0]?.url;
      if (!url) throw new Error("No image returned");
      const persisted = await persistAsset(url, ctx, "resize");
      return {
        outputs: { image: persisted },
        costUsd: estimateCost("fal-ai/flux-pro/kontext"),
        durationMs: Date.now() - t0,
      };
    }

    case "elementChange":
    case "inpaint": {
      const image = inputs.image as string;
      if (!image) throw new Error("Connect an image");
      const instr = String(config.instructions || inputs.prompt || inputs.instruction || "").trim();
      if (!instr) throw new Error("Provide an edit instruction");
      const model = String(config.model ?? "fal-ai/flux-pro/kontext");

      // nano-banana edit endpoints expect image_urls array, not image_url
      const input: Record<string, unknown> = { prompt: instr };
      if (model.includes("nano-banana")) {
        input.image_urls = [image];
      } else {
        input.image_url = image;
      }

      const r = await falRun(model, input);
      const url = ((r.images as { url: string }[] | undefined) ?? [])[0]?.url;
      if (!url) throw new Error("No image returned");
      const persisted = await persistAsset(url, ctx, "edit");
      return { outputs: { image: persisted }, costUsd: estimateCost(model), durationMs: Date.now() - t0 };
    }

    case "imageTranslation": {
      const image = inputs.image as string;
      if (!image) throw new Error("Connect an image");
      const lang = String(config.target_language ?? "Spanish");
      const model = String(config.model ?? "fal-ai/flux-pro/kontext/max");
      const r = await falRun(model, {
        image_url: image,
        prompt: `Translate all visible text to ${lang}. Preserve layout, fonts, colours, and visual style perfectly. Only change the text content.`,
      });
      const url = ((r.images as { url: string }[] | undefined) ?? [])[0]?.url;
      if (!url) throw new Error("No image returned");
      const persisted = await persistAsset(url, ctx, "translate");
      return { outputs: { image: persisted }, costUsd: estimateCost(model), durationMs: Date.now() - t0 };
    }

    case "productScreenPlacement": {
      // Placeholder: real composition would use sharp + canvas on server.
      // For now we pass through the screenshot.
      const screenshot = inputs.screenshot as string;
      if (!screenshot) throw new Error("Connect a screenshot");
      return { outputs: { composed: screenshot }, costUsd: 0, durationMs: Date.now() - t0 };
    }

    case "characterGen": {
      const desc = String(config.instructions || inputs.description || "").trim();
      if (!desc) throw new Error("Provide a description");
      const model = String(config.model ?? "fal-ai/flux/dev");
      const style = String(config.style ?? "photorealistic");
      const aspect = String(config.aspect ?? "3:4");
      const r = await falRun(model, {
        prompt: `Character, ${style} style, ${desc}, centered composition, clean background`,
        image_size: ASPECT_TO_SIZE[aspect] ?? "portrait_4_3",
        num_images: 1,
        enable_safety_checker: false,
      });
      const url = ((r.images as { url: string }[] | undefined) ?? [])[0]?.url;
      if (!url) throw new Error("No image returned");
      const persisted = await persistAsset(url, ctx, "char");
      return { outputs: { character: persisted }, costUsd: estimateCost(model), durationMs: Date.now() - t0 };
    }

    case "upscale": {
      const image = inputs.image as string;
      if (!image) throw new Error("Connect an image");
      const model = String(config.model ?? "fal-ai/clarity-upscaler");
      const scale = Number(config.scale ?? 2);
      const r = await falRun(model, { image_url: image, scale });
      const url =
        ((r.image as { url: string } | undefined)?.url) ??
        ((r.images as { url: string }[] | undefined) ?? [])[0]?.url;
      if (!url) throw new Error("No image returned");
      const persisted = await persistAsset(url, ctx, "upscale");
      return { outputs: { image: persisted }, costUsd: estimateCost(model), durationMs: Date.now() - t0 };
    }

    case "removeBg": {
      const image = inputs.image as string;
      if (!image) throw new Error("Connect an image");
      const model = String(config.model ?? "fal-ai/birefnet");
      const r = await falRun(model, { image_url: image });
      const url =
        ((r.image as { url: string } | undefined)?.url) ??
        ((r.images as { url: string }[] | undefined) ?? [])[0]?.url;
      if (!url) throw new Error("No image returned");
      const persisted = await persistAsset(url, ctx, "rmbg");
      return { outputs: { image: persisted }, costUsd: estimateCost(model), durationMs: Date.now() - t0 };
    }

    case "faceSwap": {
      const source = inputs.source as string;
      const face = inputs.face as string;
      if (!source || !face) throw new Error("Connect both source and face images");
      const model = String(config.model ?? "fal-ai/face-swap");
      const r = await falRun(model, { target_image: source, source_image: face });
      const url =
        ((r.image as { url: string } | undefined)?.url) ??
        ((r.images as { url: string }[] | undefined) ?? [])[0]?.url;
      if (!url) throw new Error("No image returned");
      const persisted = await persistAsset(url, ctx, "faceswap");
      return { outputs: { image: persisted }, costUsd: estimateCost(model), durationMs: Date.now() - t0 };
    }

    case "topazVideo": {
      const video = inputs.video as string;
      if (!video) throw new Error("Connect a video");
      const model = String(config.model ?? "Proteus");
      const input: Record<string, unknown> = {
        video_url: video,
        model,
        upscale_factor: Number(config.upscale_factor ?? 2),
      };
      // target_fps enables frame interpolation (Apollo) on fal; 0 = keep source.
      const fps = Number(config.target_fps ?? 0);
      if (fps > 0) input.target_fps = Math.round(fps);
      // Enhancement knobs: -1 means "let the model use its own default".
      for (const k of ["compression", "noise", "halo", "grain", "recover_detail"]) {
        const v = Number(config[k] ?? -1);
        if (v >= 0) input[k] = v;
      }
      if (config.h264) input.H264_output = true;
      // Topaz video is slow (minutes), especially at 4K — allow a long poll.
      const r = await falRun("fal-ai/topaz/upscale/video", input, { timeoutMs: 1_500_000 });
      const url = (r.video as { url?: string } | undefined)?.url;
      if (!url) throw new Error("No video returned");
      const persisted = await persistAsset(url, ctx, "topaz-vid");
      return { outputs: { video: persisted }, costUsd: estimateCost("fal-ai/topaz/upscale/video"), durationMs: Date.now() - t0 };
    }

    case "topazImage": {
      const image = inputs.image as string;
      if (!image) throw new Error("Connect an image");
      const model = String(config.model ?? "Standard V2");
      const input: Record<string, unknown> = {
        image_url: image,
        model,
        upscale_factor: Number(config.upscale_factor ?? 2),
        output_format: String(config.output_format ?? "png"),
      };
      if (config.subject_detection) input.subject_detection = String(config.subject_detection);
      if (config.crop_to_fill) input.crop_to_fill = true;
      const faceOn = config.face_enhancement !== false;
      input.face_enhancement = faceOn;
      if (faceOn) {
        const fc = Number(config.face_enhancement_creativity ?? -1);
        if (fc >= 0) input.face_enhancement_creativity = fc;
        const fs = Number(config.face_enhancement_strength ?? -1);
        if (fs >= 0) input.face_enhancement_strength = fs;
      }
      // Float knobs: -1 = model default; only forward when set.
      for (const k of ["sharpen", "denoise", "fix_compression", "detail", "strength"]) {
        const v = Number(config[k] ?? -1);
        if (v >= 0) input[k] = v;
      }
      // Integer knobs (Redefine): 0 = off.
      for (const k of ["creativity", "texture"]) {
        const v = Number(config[k] ?? 0);
        if (v >= 1) input[k] = Math.round(v);
      }
      if (config.prompt) input.prompt = String(config.prompt);
      if (config.autoprompt) input.autoprompt = true;
      const r = await falRun("fal-ai/topaz/upscale/image", input);
      const url =
        ((r.image as { url: string } | undefined)?.url) ??
        ((r.images as { url: string }[] | undefined) ?? [])[0]?.url;
      if (!url) throw new Error("No image returned");
      const persisted = await persistAsset(url, ctx, "topaz-img");
      return { outputs: { image: persisted }, costUsd: estimateCost("fal-ai/topaz/upscale/image"), durationMs: Date.now() - t0 };
    }

    case "uploadImage": {
      const cdnUrl = (config.cdnUrl as string) || (config.dataUrl as string);
      if (!cdnUrl) throw new Error("Upload an image first");
      return { outputs: { image: cdnUrl }, costUsd: 0, durationMs: Date.now() - t0 };
    }

    case "brandAssets": {
      // Pulls UI screenshots from the brand kit. The user selects which ones
      // to forward via the UI (BrandAssetsPicker). When nothing is selected,
      // we default to forwarding ALL of them — matches user intent of
      // "everything from the brand kit, please".
      //
      // Note: when this node is present in the graph and wired to a
      // downstream node, that downstream's `userImages.length > 0` check
      // becomes true, which DISABLES the automatic ctx.brandUiScreenshots
      // injection. So Brand Assets node acts as an explicit override —
      // exactly what the user asked for: "pick from brand kit, but still
      // use the rest of the brand context (voice, pitch, etc)".
      const allBrandScreenshots = ctx.brandUiScreenshots ?? [];
      if (allBrandScreenshots.length === 0) {
        throw new Error(
          "This brand has no UI screenshots in its Brand Kit. Add some on the brand-kit page first.",
        );
      }
      const selectedRaw = config.selected;
      const selected = Array.isArray(selectedRaw)
        ? (selectedRaw as unknown[]).filter(
            (v): v is string => typeof v === "string" && v.length > 0,
          )
        : [];
      // Intersect with currently-available screenshots so stale URLs
      // (deleted from brand kit but still in node config) don't break the run.
      const finalUrls =
        selected.length > 0
          ? selected.filter((u) => allBrandScreenshots.includes(u))
          : allBrandScreenshots;

      if (finalUrls.length === 0) {
        throw new Error(
          "Selected screenshots are no longer in the Brand Kit. Pick again.",
        );
      }

      return {
        // outputs.images = first URL as the "primary" downstream value
        // (single-port destinations get this); the full list lives in results
        // for multi-port consumers (Nano Banana refs, LLM vision inputs).
        outputs: { images: finalUrls[0] },
        results: finalUrls.map((u) => ({ value: u, mime: "image" })),
        costUsd: 0,
        durationMs: Date.now() - t0,
      };
    }

    // ─────────────────────── VIDEO
    case "videoGen": {
      const basePrompt = String(config.instructions || inputs.prompt || "cinematic slow zoom");
      // Any on-screen text in generated video must be English regardless of
      // the prompt's language.
      const prompt = `${basePrompt}\n\nIMPORTANT: Any on-screen text must be in English only.`;
      const model = String(config.model ?? "fal-ai/kling-video/v3/pro/image-to-video");
      const duration = String(config.duration ?? "5");
      const resolution = String(config.resolution ?? "");
      const aspect = String(config.aspect ?? "9:16");
      const generateAudio = Boolean(config.generate_audio);
      const isImg2Vid =
        model.includes("image-to-video") ||
        model.includes("first-last-frame-to-video") ||
        model.includes("reference-to-video");
      const isText2Vid = model.includes("text-to-video");
      const startFrame = (inputs.start_frame ?? inputs.image) as string | undefined;
      const endFrame = inputs.end_frame as string | undefined;
      // Legacy single `reference` port — still wired for old workflows
      // saved before patch 5.1. New workflows use the multi-port
      // `references` (filled when mode === "references"), captured below.
      const legacyReference = inputs.reference as string | undefined;
      // References mode: multi-port `references` arrives as string[].
      // The executor's multi-port machinery + BrandAssets expansion is
      // already wired up — by the time we get here we have a clean
      // array of URLs in edge-connection order (so the user controls
      // sequence via their Brand Assets selection order or the order
      // they wired edges).
      const referencesArr = Array.isArray(inputs.references)
        ? (inputs.references as unknown[]).filter(
            (v): v is string => typeof v === "string" && v.length > 0,
          )
        : [];
      // References port is image-only; videos arrive on a dedicated
      // `reference_videos` port (Seedance reference-to-video multimodal).
      const referenceVideosArr = Array.isArray(inputs.reference_videos)
        ? (inputs.reference_videos as unknown[]).filter(
            (v): v is string => typeof v === "string" && v.length > 0,
          )
        : [];
      const isVideoUrl = (u: string) => /\.(mp4|mov|webm|m4v|avi|mkv)(\?|#|$)/i.test(u);
      // The mode field gates port visibility on the canvas. Legacy nodes
      // saved before patch 5.1 won't have it; treat absence as "image"
      // for routing decisions but fall back gracefully if frames came
      // through anyway (e.g. user wired end_frame on a legacy node).
      const mode = String(config.mode ?? "image");

      // Video-to-Video (Kling O3 v2v/edit + v2v/reference). Source video
      // comes through the `source_video` port; refs (if any) become
      // image_urls. keep_audio controls whether the source track survives.
      const sourceVideo = inputs.source_video as string | undefined;
      const keepAudio = config.keep_audio !== false; // default true
      const isV2V = model.includes("/video-to-video/");

      if (mode === "video-to-video") {
        if (!isV2V) {
          throw new Error(
            `Mode is Video-to-Video but model "${model}" isn't a V2V endpoint. Pick a "Kling O1 — Edit" or "— Restyle" model.`,
          );
        }
        if (!sourceVideo) {
          throw new Error("Video-to-Video needs a source video connected to the Source video port");
        }
      }
      // Guard the reverse too — a V2V model selected outside v2v mode has
      // no source video and would 400 on fal.
      if (isV2V && !sourceVideo) {
        throw new Error("This V2V model needs a source video. Switch Mode to Video-to-Video and connect one.");
      }

      if (isImg2Vid && !startFrame && !legacyReference && referencesArr.length === 0 && !isText2Vid && !isV2V)
        throw new Error("This model needs a start frame or reference image");

      // Hard guardrails for References mode — fail fast with a clear
      // message rather than silently sending a request that fal will
      // either reject or, worse, accept but ignore the refs.
      if (mode === "references" && referencesArr.length === 0) {
        throw new Error("References mode needs at least one reference image connected to the References port");
      }
      if (mode === "references") {
        const supportsRefs = model.includes("/reference-to-video");
        if (!supportsRefs) {
          throw new Error(
            `Model ${model} doesn't accept multiple reference images. Pick a "Reference" model (Kling O3 reference-to-video or Seedance reference-to-video) for References mode.`,
          );
        }
        // Cap to fal-side limits: o3 pro/std + seedance accept up to 4,
        // o3/4k up to 7. Trim silently so users with brand kits of 10+
        // selected screenshots don't blow up the request.
        const cap = model.includes("/4k/") ? 7 : 4;
        if (referencesArr.length > cap) {
          console.warn(
            `[videoGen] References capped from ${referencesArr.length} → ${cap} for ${model}`,
          );
          referencesArr.length = cap;
        }
      }

      // ─── Multi-shot mode ────────────────────────────────────────────
      // Kling V3 and O3 natively support `multi_prompt` — a list of
      // scenes that get stitched into a SINGLE output video server-side
      // (not N separate runs). Each scene has its own prompt + duration.
      // Only V3/O3 endpoints expose this field, so we hard-fail with a
      // clear error if the user picked something else.
      //
      // Format observed in fal docs:
      //   multi_prompt: [{ prompt: string, duration?: string }, ...]
      // We pass `shot_type: "customize"` (user-authored shots) — the
      // alternative "intelligent" lets Kling auto-split a single
      // prompt, which we don't want here since the whole point of this
      // mode is the user authoring shots explicitly.
      type Scene = { id?: string; prompt: string; duration?: string };
      const scenesRaw = Array.isArray(config.scenes) ? (config.scenes as Scene[]) : [];
      const scenes: Scene[] = scenesRaw
        .filter((s) => s && typeof s.prompt === "string" && s.prompt.trim().length > 0)
        .map((s) => ({
          prompt: s.prompt.trim(),
          duration: String(s.duration ?? "5"),
        }));

      if (mode === "multi-shot") {
        const supportsMultiShot =
          model.includes("/v3/") || model.includes("/o3/");
        if (!supportsMultiShot) {
          throw new Error(
            `Model ${model} doesn't support multi-shot. Pick a Kling V3 or O3 model (any tier) for Multi-shot mode.`,
          );
        }
        if (scenes.length === 0) {
          throw new Error(
            "Multi-shot mode needs at least one scene with a non-empty prompt. Open the node and use the scene builder.",
          );
        }
        if (scenes.length < 2) {
          // Single-scene multi-shot is technically valid on fal but
          // defeats the purpose. Allow with a warning rather than block,
          // since some users might be iterating.
          console.warn(
            `[videoGen] Multi-shot with only ${scenes.length} scene(s) — consider using Image/Text mode instead`,
          );
        }
      }

      const payload: Record<string, unknown> = {};
      if (mode === "multi-shot") {
        // multi_prompt + prompt are MUTUALLY EXCLUSIVE on Kling endpoints
        // (docs: "Either prompt or multi_prompt must be provided, but not
        // both"). Don't include `prompt` at all in this branch.
        payload.multi_prompt = scenes;
        payload.shot_type = "customize";
      } else {
        // Auto-reference connected inputs so users don't have to type @Image1 /
        // [Image1] tokens by hand. Only for ref-using modes, only when the user
        // hasn't already referenced inputs themselves. Seedance uses [Image1] /
        // [Video1] (square brackets); Kling uses @Image1.
        let promptOut = prompt;
        if (
          (mode === "references" || mode === "video-to-video") &&
          referencesArr.length > 0 &&
          !/[@\[]\s*(image|video|element|audio)\s*\d/i.test(promptOut)
        ) {
          const seed = model.includes("seedance");
          const imgN = referencesArr.length;
          const vidN = referenceVideosArr.length;
          const toks: string[] = [];
          if (seed) {
            for (let i = 1; i <= imgN; i++) toks.push(`[Image${i}]`);
            for (let i = 1; i <= vidN; i++) toks.push(`[Video${i}]`);
          } else {
            // Kling: image refs → @ImageN (videos are the source / filtered out)
            for (let i = 1; i <= imgN; i++) toks.push(`@Image${i}`);
          }
          if (toks.length) {
            if (mode === "video-to-video") {
              // EDIT must transform the source video, not regenerate from the
              // image. Anchor hard: apply the ref only to the described area and
              // keep everything else from the source clip.
              promptOut = `${promptOut.trim()} Apply ${toks.join(", ")} only to the area described above; keep the source video's subjects, hands, motion, camera movement, framing and lighting exactly unchanged. Do not regenerate the scene from the reference image.`;
            } else {
              promptOut = `${promptOut.trim()} Use ${toks.join(", ")} as reference${toks.length > 1 ? "s" : ""}.`;
            }
          }
        }
        payload.prompt = promptOut;
      }

      // ─── Video-to-Video branch ──────────────────────────────────────
      // Kling O3 v2v/edit + v2v/reference. Different schema from i2v:
      //   video_url (required) + prompt (references video as @Video1) +
      //   optional image_urls (style/element refs, max 4 with video) +
      //   keep_audio. We branch BEFORE the kling i2v block because these
      //   endpoints also contain "kling-video" but must NOT get
      //   start_image_url / end_image_url / aspect_ratio treatment.
      if (isV2V) {
        payload.video_url = sourceVideo;
        if (referencesArr.length > 0) {
          // Kling v2v: image references only (max 4 total when a video is
          // present per Kling docs). The References port is image-typed, so
          // these are already images.
          payload.image_urls = referencesArr.slice(0, 4);
        }
        payload.keep_audio = keepAudio;
        // Kling O1 v2v (edit + reference) derive duration AND aspect ratio from
        // the source video — neither endpoint has those fields, so sending them
        // risks a 422. The source video must be .mp4/.mov, 3-10s, 720-2160px.
      } else if (model.includes("kling-video")) {
        // ─── Endpoint flavor detection ─────────────────────────────────
        // V3 is the newest, O3 is the older flagship line, V2.x is legacy.
        // The three lines disagree on field names — V3 i2v wants
        // start_image_url, O3 i2v wants image_url, etc. Get it wrong and
        // fal silently ignores the field (no 422, you just don't see the
        // end frame applied — exactly what was happening before this fix).
        const isV3 = model.includes("/v3/");
        const isO3 = model.includes("/o3/");
        const isV3OrO3 = isV3 || isO3;
        const isKlingI2V = model.includes("image-to-video");
        const isKlingT2V = model.includes("text-to-video");
        const isKlingRefToVid = model.includes("reference-to-video");

        // Start frame:
        //   V3 i2v → start_image_url (required by API)
        //   V3/O3 reference-to-video → start_image_url (optional)
        //   O3 i2v + V2.x i2v + any /4k/ i2v → image_url
        if (startFrame) {
          if ((isV3 && isKlingI2V) || isKlingRefToVid) {
            payload.start_image_url = startFrame;
          } else {
            payload.image_url = startFrame;
          }
        }

        // End frame:
        //   V3/O3 → end_image_url
        //   V2.x legacy → tail_image_url (kept untouched for compat)
        // This was the silent bug: code used tail_image_url for all kling
        // including V3, where fal accepts only end_image_url. End frame
        // was effectively ignored on V3 i2v.
        if (endFrame) {
          if (isV3OrO3) payload.end_image_url = endFrame;
          else payload.tail_image_url = endFrame;
        }

        // Reference images (NEW: References mode multi-port + legacy single)
        //   References mode → up to 4 (pro/std) or 7 (4k) URLs in image_urls
        //   Legacy single `reference` port → wrapped into image_urls [url]
        //     for reference-to-video endpoints, ignored elsewhere on V3/O3
        //     (no schema field accepted them anyway, see comment below),
        //     stored as reference_image_url on V2.x for compat.
        // Order of precedence: multi-port wins if both somehow set.
        const refList: string[] =
          referencesArr.length > 0
            ? referencesArr
            : legacyReference
              ? [legacyReference]
              : [];
        if (refList.length > 0) {
          if (isKlingRefToVid) {
            // Kling reference-to-video accepts image references only.
            payload.image_urls = refList.filter((u) => !isVideoUrl(u));
          } else if (!isV3OrO3) {
            // V2.x legacy compat — only the first ref fits the single field
            payload.reference_image_url = refList[0];
          }
          // V3/O3 i2v + t2v have no schema field for refs. We already
          // throw above when mode === "references" + non-ref model, so
          // any silent drops here only happen for legacy nodes that
          // wired the old single port to a V3/O3 i2v — same behaviour
          // they had post-patch 5.0.
        }

        payload.duration = duration;

        // aspect_ratio:
        //   Accepted by: t2v, reference-to-video, any /4k/ endpoint, V2.x.
        //   NOT accepted by: V3/O3 i2v at pro/standard tier. fal silently
        //     ignores it there, but cleaner to omit so logs aren't noisy.
        const acceptsAspect =
          isKlingT2V ||
          isKlingRefToVid ||
          model.includes("/4k/") ||
          !isV3OrO3;
        if (acceptsAspect) payload.aspect_ratio = aspect;

        // generate_audio:
        //   V3 → fal default is TRUE. To honor the user's OFF toggle we
        //     must send explicit false. Always send an explicit bool.
        //   O3 / V2.x → fal default is FALSE. Send only when user wants ON.
        if (isV3) {
          payload.generate_audio = generateAudio;
        } else if (generateAudio) {
          payload.generate_audio = true;
        }
      } else if (model.includes("seedance-2.0")) {
        // Seedance: image_url (start), end_image_url, references via
        // image_urls list on the reference-to-video endpoint specifically.
        // Other Seedance endpoints (i2v / t2v / fast variants) accept
        // only [Image1]-style inline prompt refs, which the multi-port
        // flow doesn't address. Refs are only sent on the ref-to-video
        // endpoint to avoid silent ignores.
        if (startFrame) payload.image_url = startFrame;
        if (endFrame) payload.end_image_url = endFrame;
        if (model.includes("/reference-to-video")) {
          const imgs =
            referencesArr.length > 0
              ? referencesArr
              : legacyReference
                ? [legacyReference]
                : [];
          if (imgs.length) payload.image_urls = imgs;
          // Seedance 2.0 is multimodal — reference up to 3 videos via video_urls
          // (addressed as [Video1], [Video2] in the prompt).
          if (referenceVideosArr.length) payload.video_urls = referenceVideosArr;
        }
        payload.duration = duration;
        payload.resolution = resolution || "720p";
        payload.aspect_ratio = aspect;
        payload.generate_audio = generateAudio;
      } else if (model.includes("veo3")) {
        // Veo 3.1 fixes (5 bugs that caused 422):
        //   1. duration must be "4s" / "6s" / "8s" — STRING with "s" suffix.
        //      We were sending a bare number → 422.
        //   2. first-last-frame requires a SEPARATE endpoint
        //      (fal-ai/veo3.1/fast/first-last-frame-to-video) with
        //      `first_frame_url` + `last_frame_url`. The old `last_image_url`
        //      param on the normal i2v endpoint was rejected.
        //   3. Veo 3.1 uses `audio: true|false`. Veo 3 (older) still uses
        //      `generate_audio`. The `model` string lets us tell them apart.
        //   4. aspect_ratio allowed values are auto / 16:9 / 9:16 only.
        //      Other ratios (1:1 etc) cause 422. Coerce silently to auto.
        //   5. first-last-frame endpoint REQUIRES both frames. If user
        //      picked first-last but only provided start, we'd 422. Now we
        //      auto-route to the i2v endpoint of the same tier instead.
        const isVeo31 = model.includes("/veo3.1");
        const isFirstLast = model.includes("first-last-frame-to-video");
        const isFast = model.includes("/fast");

        // Routing decisions: pick the right endpoint based on which frames
        // the user actually provided.
        let actualModel = model;
        if (isVeo31 && startFrame && endFrame && !isFirstLast) {
          // User has both frames but picked plain i2v — upgrade to first-last.
          actualModel = isFast
            ? "fal-ai/veo3.1/fast/first-last-frame-to-video"
            : "fal-ai/veo3.1/first-last-frame-to-video";
        } else if (isVeo31 && isFirstLast && !endFrame) {
          // User picked first-last but only has start — fall back to plain
          // i2v so it still generates instead of 422.
          actualModel = isFast
            ? "fal-ai/veo3.1/fast/image-to-video"
            : "fal-ai/veo3.1/image-to-video";
        }

        if (actualModel.includes("first-last-frame-to-video")) {
          if (startFrame) payload.first_frame_url = startFrame;
          if (endFrame) payload.last_frame_url = endFrame;
        } else {
          if (startFrame) payload.image_url = startFrame;
        }

        // Duration: coerce to "Ns" form. Veo accepts ONLY "4s", "6s", "8s".
        // Anything else (5, 10) → pick nearest legal value. Symptom this
        // fixes: user selects "5s" in UI, Veo always generates 8s because
        // the previous code defaulted unknowns to 8.
        const durNum = parseInt(String(duration).replace(/\D/g, ""), 10) || 8;
        const allowedVeo = [4, 6, 8] as const;
        const pickedDur =
          allowedVeo.find((d) => d === durNum) ??
          allowedVeo.reduce(
            (best, d) => (Math.abs(d - durNum) < Math.abs(best - durNum) ? d : best),
            8,
          );
        payload.duration = `${pickedDur}s`;

        // Aspect: only auto / 16:9 / 9:16 supported.
        payload.aspect_ratio = ["auto", "16:9", "9:16"].includes(aspect) ? aspect : "auto";
        if (resolution) payload.resolution = resolution; // Veo 3.1 accepts 720p / 1080p

        // Audio param: Veo 3.1 uses `audio`; older Veo 3 uses `generate_audio`.
        if (isVeo31) {
          payload.audio = generateAudio;
        } else if (generateAudio) {
          payload.generate_audio = true;
        }

        // Log the exact payload — when something fails (e.g. specific
        // duration+aspect combos), we want to see in Vercel logs what we
        // actually sent so we can trace which field fal rejected.
        console.log("[veo] submitting", actualModel, JSON.stringify(payload));
        const r = await falRun(actualModel, payload);
        const url =
          (r.video as { url: string } | undefined)?.url ??
          (r.video_url as string | undefined) ??
          ((r.videos as { url: string }[] | undefined)?.[0]?.url);
        if (!url) throw new Error("No video returned");
        const persisted = await persistAsset(url, ctx, "vid");
        return {
          outputs: { video: persisted },
          costUsd: estimateCost(actualModel, { duration: pickedDur }),
          durationMs: Date.now() - t0,
        };
      } else {
        // Default: try common field names
        if (startFrame) payload.image_url = startFrame;
        if (endFrame) payload.end_image_url = endFrame;
        if (legacyReference) payload.reference_image_url = legacyReference;
        payload.duration = duration;
        payload.aspect_ratio = aspect;
      }

      // Log the exact payload so failures (wrong field, bad duration, source
      // video out of Kling's 3-10s range, etc.) are traceable in Vercel logs.
      console.log("[videoGen] submitting", model, "mode=" + mode, JSON.stringify(payload).slice(0, 800));
      const r = await falRun(model, payload);
      const url =
        (r.video as { url: string } | undefined)?.url ??
        (r.video_url as string | undefined) ??
        ((r.videos as { url: string }[] | undefined)?.[0]?.url);
      if (!url) throw new Error("No video returned");
      const persisted = await persistAsset(url, ctx, "vid");
      return {
        outputs: { video: persisted },
        costUsd: estimateCost(model, { duration: Number(duration) }),
        durationMs: Date.now() - t0,
      };
    }

    case "screenReplace": {
      // Replace a green-screen phone/device screen with connected content via a
      // pixel-exact chroma-key composite (image OR video) with per-frame planar
      // tracking. Best for steady/frontal shots on clean green.
      const sourceVideo = String(inputs.source_video || "").trim();
      const screen = String(inputs.screen || "").trim();
      if (!sourceVideo) throw new Error("Connect the green-screen source video to the Source video port");
      if (!screen) throw new Error("Connect the screen content (image or video) to the Screen content port");
      const keyColor = String(config.key_color || "#00FF00").trim();
      const similarity = Number(config.key_similarity) || 0.3;
      const scaleX = Number(config.scale_x);
      const scaleY = Number(config.scale_y);
      const matteChoke = Number(config.matte_choke);
      const feather = Number(config.feather);
      const trackOffsetX = Number(config.track_offset_x);
      const trackOffsetY = Number(config.track_offset_y);
      const trackRotate = Number(config.track_rotate);
      let trackKeys: { t: number; dx?: number; dy?: number; rot?: number }[] = [];
      if (typeof config.track_keys === "string" && config.track_keys.trim()) {
        try { const parsed = JSON.parse(config.track_keys); if (Array.isArray(parsed)) trackKeys = parsed; } catch { /* ignore malformed keyframe JSON */ }
      }
      const screenIsVideo = /\.(mp4|mov|webm|m4v|avi|mkv)(\?|#|$)/i.test(screen);

      const [srcResp, contentResp] = await Promise.all([fetch(sourceVideo), fetch(screen)]);
      if (!srcResp.ok) throw new Error(`Could not fetch the source video (${srcResp.status})`);
      if (!contentResp.ok) throw new Error(`Could not fetch the screen content (${contentResp.status})`);
      const srcBuf = Buffer.from(await srcResp.arrayBuffer());
      const contentBuf = Buffer.from(await contentResp.arrayBuffer());
      const trackOut: { fps?: number; w?: number; h?: number; quads?: number[][][] } = {};
      let outBuf: Buffer;
      try {
        outBuf = await compositeGreenScreen({
          source: srcBuf, content: contentBuf, contentIsVideo: screenIsVideo,
          keyColorHex: keyColor, similarity,
          fit: String(config.fit ?? "fill") === "cover" ? "cover" : "fill",
          scaleX: isFinite(scaleX) && scaleX > 0 ? scaleX : 1,
          scaleY: isFinite(scaleY) && scaleY > 0 ? scaleY : 1,
          matteChoke: isFinite(matteChoke) ? matteChoke : 0,
          feather: isFinite(feather) ? feather : 0,
          trackOffsetX: isFinite(trackOffsetX) ? trackOffsetX : 0,
          trackOffsetY: isFinite(trackOffsetY) ? trackOffsetY : 0,
          trackRotate: isFinite(trackRotate) ? trackRotate : 0,
          trackKeys,
          trackMode: (config.track_mode === "keys" || config.track_mode === "region") ? config.track_mode : "anchor",
          captureTrack: trackOut,
        });
      } catch (e) {
        throw new Error(`Composite failed (ffmpeg): ${e instanceof Error ? e.message : String(e)}`);
      }
      const outPath = buildStoragePath({
        brandId: ctx.brandId, projectId: ctx.projectId, workflowId: ctx.workflowId,
        runStepId: ctx.runStepId, prefix: "screen", ext: "mp4",
      });
      const { cdnUrl } = await uploadBytes(outBuf, outPath, "video/mp4");
      if (!cdnUrl) throw new Error("Failed to upload the composited video");
      // Cache the auto-track (computed for free during this render) so the visual
      // track editor opens instantly next time instead of recomputing it.
      let trackUrl = "";
      if (trackOut.quads && trackOut.quads.length) {
        try {
          const trackPath = buildStoragePath({
            brandId: ctx.brandId, projectId: ctx.projectId, workflowId: ctx.workflowId,
            runStepId: ctx.runStepId, prefix: "screen-track", ext: "json",
          });
          const up = await uploadBytes(Buffer.from(JSON.stringify(trackOut)), trackPath, "application/json");
          trackUrl = up.cdnUrl || "";
        } catch { /* non-fatal: editor falls back to recompute */ }
      }
      console.log("[screenReplace] composite done", outPath);
      return { outputs: { video: cdnUrl, ...(trackUrl ? { track_url: trackUrl } : {}) }, costUsd: 0, durationMs: Date.now() - t0 };
    }

    case "heygenVideo": {
      const prompt = String(config.instructions || inputs.prompt || "").trim();
      if (!prompt) throw new Error("Provide a prompt/script (input or instructions)");
      const avatarId = String(config.avatar_id || "").trim();
      const voiceId = String(config.voice_id || "").trim();
      const avatarImage = String(inputs.image || "").trim(); // custom avatar from a connected picture
      const background = config.bgEnabled ? String(config.bgColor || "#00FF00") : undefined;
      const [w, h] = String(config.dimension || "720x1280").split("x").map((n) => parseInt(n, 10));
      let videoId: string;
      let url: string;
      const engine = String(config.engine || "");
      if (avatarImage) {
        // Custom avatar from a connected image → Avatar IV via the documented
        // /v2/videos endpoint with direct image_url. Credits-based, exposes a
        // real aspect_ratio (16:9 / 9:16) + resolution + background, and does
        // NOT create a permanent photo avatar (no slot limit).
        // so it never hits the plan's photo-avatar slot limit.
        if (!voiceId) throw new Error("Custom avatar needs a voice — pick one in the node");
        try {
          const ww = w || 720, hh = h || 1280;
          // Endpoint supports only 16:9 / 9:16 (no 1:1) — square falls back to 16:9.
          const aspectRatio: "16:9" | "9:16" = ww < hh ? "9:16" : "16:9";
          const resolution: "720p" | "1080p" = Math.max(ww, hh) >= 1920 ? "1080p" : "720p";
          videoId = await createAvatarIVVideo({
            imageUrl: avatarImage, script: prompt, voiceId,
            aspectRatio, resolution,
            background: background || undefined,
            speed: Number(config.speed) || 1,
          });
          url = await pollVideoStatus(videoId);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (/credit|insufficient|quota/i.test(msg)) {
            throw new Error("HeyGen credits exhausted for this Avatar IV render. Top up credits in your HeyGen account, then re-run.");
          }
          if (/limit|photo avatar/i.test(msg)) {
            throw new Error("HeyGen rejected the custom-avatar request. Avatar IV from a photo runs on credits — check your HeyGen credit balance and API plan.");
          }
          throw e;
        }
      } else if (avatarId && voiceId) {
        // Full mode: explicit library avatar + voice (v2). Script spoken verbatim.
        const eng = engine || "av3"; // default Avatar III for library avatars
        videoId = await createAvatarVideo({
          script: prompt, avatarId, voiceId,
          avatarStyle: String(config.avatar_style || "normal"),
          width: w || 720, height: h || 1280, background, speed: Number(config.speed) || 1,
          useAvatarIV: eng === "av4",
        });
        url = await pollVideoStatus(videoId);
      } else if (avatarId || voiceId) {
        throw new Error("Pick BOTH an avatar and a voice (or connect an avatar image, or clear everything for the prompt agent)");
      } else {
        // Prompt-agent mode: HeyGen decides avatar/voice from the prompt (v3).
        videoId = await createVideoFromPrompt(prompt);
        url = await pollVideo(videoId);
      }
      const persisted = await persistAsset(url, ctx, "heygen");
      return {
        // Cost is billed by HeyGen in credits (plan-dependent); not mapped to
        // USD yet, so reported as 0 here. TODO: credits→USD once a plan is set.
        outputs: { video: persisted },
        costUsd: 0,
        durationMs: Date.now() - t0,
        metadata: { provider: "heygen", videoId },
      };
    }

    case "talkingHead":
    case "lipsync": {
      const video = inputs.video as string;
      const audio = inputs.audio as string;
      if (!video || !audio) throw new Error("Need both video and audio");
      const model = String(config.model ?? "fal-ai/sync-lipsync");
      const r = await falRun(model, { video_url: video, audio_url: audio });
      const url = (r.video as { url: string } | undefined)?.url;
      if (!url) throw new Error("No video returned");
      const persisted = await persistAsset(url, ctx, "lipsync");
      return { outputs: { video: persisted }, costUsd: estimateCost(model), durationMs: Date.now() - t0 };
    }

    case "motionTransfer": {
      // Approximation: use an image-to-video model with the image input; we ignore the reference video for now.
      const image = inputs.image as string;
      if (!image) throw new Error("Connect a target image");
      const model = String(config.model ?? "fal-ai/runway-gen3/turbo/image-to-video");
      const r = await falRun(model, { image_url: image, prompt: "transfer motion from reference" });
      const url = (r.video as { url: string } | undefined)?.url;
      if (!url) throw new Error("No video returned");
      const persisted = await persistAsset(url, ctx, "motion");
      return {
        outputs: { video: persisted },
        costUsd: estimateCost(model, { duration: 5 }),
        durationMs: Date.now() - t0,
      };
    }

    case "uploadVideo": {
      const cdnUrl = (config.cdnUrl as string) || (config.url as string);
      if (!cdnUrl) throw new Error("Upload a video or paste URL");
      return { outputs: { video: cdnUrl }, costUsd: 0, durationMs: Date.now() - t0 };
    }

    // ─────────────────────── AUDIO
    case "voiceover": {
      const text = inputs.text as string;
      if (!text) throw new Error("Connect text input");
      const voice = String(config.voice ?? "Rachel");
      const stability = Number(config.stability ?? 0.5);
      const model = String(config.model ?? "fal-ai/elevenlabs/tts/multilingual-v2");
      const r = await falRun(model, { text, voice, stability });
      const url = ((r.audio as { url: string } | undefined)?.url) ?? (r.audio_url as string | undefined);
      if (!url) throw new Error("No audio returned");
      const persisted = await persistAsset(url, ctx, "voice");
      return { outputs: { audio: persisted }, costUsd: estimateCost(model), durationMs: Date.now() - t0 };
    }

    case "musicGen":
    case "sfxGen": {
      const prompt = String(config.instructions || inputs.description || "").trim();
      if (!prompt) throw new Error("Provide a description");
      const model = String(
        config.model ?? (type === "sfxGen" ? "fal-ai/elevenlabs/sound-effects" : "fal-ai/stable-audio"),
      );
      const duration = Number(config.duration ?? (type === "sfxGen" ? 3 : 10));
      const r = await falRun(model, { prompt, duration, seconds_total: duration });
      const url =
        ((r.audio as { url: string } | undefined)?.url) ??
        ((r.audio_file as { url: string } | undefined)?.url) ??
        (r.audio_url as string | undefined);
      if (!url) throw new Error("No audio returned");
      const persisted = await persistAsset(url, ctx, type === "sfxGen" ? "sfx" : "music");
      return { outputs: { audio: persisted }, costUsd: estimateCost(model, { duration }), durationMs: Date.now() - t0 };
    }

    case "uploadAudio": {
      const cdnUrl = (config.cdnUrl as string) || (config.url as string);
      if (!cdnUrl) throw new Error("Upload audio or paste URL");
      return { outputs: { audio: cdnUrl }, costUsd: 0, durationMs: Date.now() - t0 };
    }

    // ─────────────────────── STRUCTURAL — passthrough containers
    case "hook":
    case "body":
    case "packShot":
    case "cta":
    case "scene": {
      const result = inputs.video ?? inputs.image ?? inputs.audio ?? inputs.text;
      return { outputs: { section: result }, costUsd: 0, durationMs: Date.now() - t0 };
    }

    case "transition":
    case "logoReveal":
      return { outputs: { video: inputs.from ?? inputs.logo ?? null }, costUsd: 0, durationMs: Date.now() - t0 };

    // ─────────────────────── INTEGRATION
    case "customApi": {
      const url = String(config.url ?? "");
      if (!url) throw new Error("Set endpoint URL");
      const method = String(config.method ?? "POST");
      let headers: Record<string, string> = {};
      try {
        const h = String(config.headers ?? "").trim();
        if (h) headers = JSON.parse(h);
      } catch {
        throw new Error("Headers must be valid JSON");
      }
      const inputStr =
        typeof inputs.input === "string" ? inputs.input : JSON.stringify(inputs.input ?? "");
      const escForJson = inputStr.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
      const replacedUrl = url.replace(/\{\{input\}\}/g, encodeURIComponent(inputStr));
      const body =
        method !== "GET" && config.body
          ? String(config.body).replace(/\{\{input\}\}/g, escForJson)
          : undefined;
      const res = await fetch(replacedUrl, { method, headers, body });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const ct = res.headers.get("content-type") ?? "";
      let result: unknown = ct.includes("json") ? await res.json() : await res.text();
      const path = String(config.response_path ?? "").trim();
      if (path) {
        for (const k of path.split(".")) {
          if (Array.isArray(result)) result = result[Number(k)];
          else if (result && typeof result === "object") result = (result as Record<string, unknown>)[k];
        }
      }
      return { outputs: { output: result }, costUsd: 0, durationMs: Date.now() - t0 };
    }

    case "webhook": {
      const url = String(config.url ?? "");
      if (!url) throw new Error("Set a webhook URL");
      const method = String(config.method ?? "POST");
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: inputs.payload, timestamp: new Date().toISOString() }),
      });
      return {
        outputs: { response: (await res.text()).slice(0, 500) },
        costUsd: 0,
        durationMs: Date.now() - t0,
      };
    }

    // ─────────────────────── TOOLS
    case "subtitles": {
      const media = String(inputs.media || "").trim();
      if (!media.startsWith("http")) throw new Error("Connect an audio or video URL to the media input");
      const key = process.env.ASSEMBLYAI_API_KEY;
      if (!key) throw new Error("ASSEMBLYAI_API_KEY is not set");
      const lang = String(config.language || "auto");
      // AssemblyAI deprecated the singular `speech_model`; it now wants a
      // prioritised list `speech_models` (first available wins).
      const payload: Record<string, unknown> = { audio_url: media, speech_models: ["universal-3-pro", "universal-2"] };
      if (lang === "auto") payload.language_detection = true; else payload.language_code = lang;
      const sub = await fetch("https://api.assemblyai.com/v2/transcript", {
        method: "POST", headers: { authorization: key, "content-type": "application/json" }, body: JSON.stringify(payload),
      });
      const sj = (await sub.json()) as { id?: string; error?: string };
      if (!sub.ok || !sj.id) throw new Error(sj.error || `AssemblyAI HTTP ${sub.status}`);
      let words: { text: string; start: number; end: number }[] = [];
      let text = "";
      for (let i = 0; i < 90; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        const pr = await fetch(`https://api.assemblyai.com/v2/transcript/${sj.id}`, { headers: { authorization: key } });
        const pj = (await pr.json()) as { status?: string; error?: string; text?: string; words?: { text: string; start: number; end: number }[] };
        if (pj.status === "completed") { text = pj.text || ""; words = pj.words || []; break; }
        if (pj.status === "error") throw new Error(pj.error || "transcription failed");
      }
      if (!text && !words.length) throw new Error("Transcription timed out");
      return {
        outputs: { text, words: JSON.stringify(words.map((w) => ({ text: w.text, start: w.start / 1000, end: w.end / 1000 }))) },
        costUsd: 0, durationMs: Date.now() - t0,
      };
    }
    case "composer": {
      const u = typeof config.exportUrl === "string" && config.exportUrl ? config.exportUrl : null;
      return { outputs: u ? { video: u } : {}, costUsd: 0, durationMs: Date.now() - t0 };
    }
    case "note":
    case "output":
    case "exportMP4":
    case "exportAE":
    case "exportImage":
    case "exportAudio":
      return { outputs: {}, costUsd: 0, durationMs: Date.now() - t0 };

    default:
      throw new Error(`Unknown node type: ${type}`);
  }
}
