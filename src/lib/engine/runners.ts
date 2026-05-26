// Server-side node execution.
// Each runner takes resolved inputs + config and returns outputs.
// Generated assets are uploaded to Supabase Storage and recorded in DB.

import { falLLM, falRun, estimateCost } from "@/lib/fal/client";
import { getSystemPrompt } from "./systemPrompts";
import { uploadFromUrl, buildStoragePath, extFromUrl, kindFromMime } from "@/lib/storage";

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
      const model = String(config.model ?? "anthropic/claude-haiku-latest");
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
      const text = await falLLM(prompt, model, temperature, images, systemPrompt);
      return {
        outputs: { text },
        costUsd: estimateCost("any-llm"),
        durationMs: Date.now() - t0,
      };
    }

    case "adAnalysis": {
      const instructions = String(config.instructions ?? "");
      const model = String(config.model ?? "anthropic/claude-sonnet-latest");
      const temperature = Number(config.temperature ?? 0.4);
      const description = inputs.description as string | undefined;
      const images = collectImages(inputs);
      const parts = [instructions];
      if (description) parts.push(`Description: ${description}`);
      const systemPrompt = getSystemPrompt("adAnalysis");
      const text = await falLLM(parts.join("\n\n"), model, temperature, images, systemPrompt);
      return { outputs: { analysis: text }, costUsd: estimateCost("any-llm"), durationMs: Date.now() - t0 };
    }

    // ─────────────────────── IMAGE
    case "imageGen": {
      const prompt = String(config.instructions || inputs.prompt || "").trim();
      if (!prompt) throw new Error("Provide a prompt (input or instructions)");
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
      const prompt = String(config.instructions || inputs.prompt || "cinematic slow zoom");
      const model = String(config.model ?? "fal-ai/kling-video/v3/pro/image-to-video");
      const duration = String(config.duration ?? "5");
      const aspect = String(config.aspect ?? "9:16");
      const generateAudio = Boolean(config.generate_audio);
      const isImg2Vid =
        model.includes("image-to-video") ||
        model.includes("first-last-frame-to-video") ||
        model.includes("reference-to-video");
      const isText2Vid = model.includes("text-to-video");
      const startFrame = (inputs.start_frame ?? inputs.image) as string | undefined;
      const endFrame = inputs.end_frame as string | undefined;
      const reference = inputs.reference as string | undefined;

      if (isImg2Vid && !startFrame && !reference && !isText2Vid)
        throw new Error("This model needs a start frame or reference image");

      const payload: Record<string, unknown> = { prompt };

      // Model-family-specific field mapping (verified from fal.ai docs)
      if (model.includes("kling-video")) {
        // Kling v3 I2V uses `start_image_url`; older v2.1 + 4K + o3 use `image_url`.
        // For T2V no image needed at all.
        const isKlingV3I2V = model.includes("/v3/") && model.includes("image-to-video");
        if (startFrame) {
          if (isKlingV3I2V) payload.start_image_url = startFrame;
          else payload.image_url = startFrame;
        }
        if (endFrame) payload.tail_image_url = endFrame;
        if (reference) payload.reference_image_url = reference;
        payload.duration = duration;
        payload.aspect_ratio = aspect;
        if (generateAudio) payload.generate_audio = true;
      } else if (model.includes("seedance-2.0")) {
        // Seedance: image_url (start), end_image_url, references via [Image1] in prompt
        if (startFrame) payload.image_url = startFrame;
        if (endFrame) payload.end_image_url = endFrame;
        payload.duration = duration;
        payload.resolution = "720p";
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
        if (reference) payload.reference_image_url = reference;
        payload.duration = duration;
        payload.aspect_ratio = aspect;
      }

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
