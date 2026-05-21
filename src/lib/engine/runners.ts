// Server-side node execution.
// Each runner takes resolved inputs + config and returns outputs.
// Generated assets are uploaded to Supabase Storage and recorded in DB.

import { falLLM, falRun, estimateCost } from "@/lib/fal/client";
import { uploadFromUrl, buildStoragePath, extFromUrl, kindFromMime } from "@/lib/storage";

export type RunnerContext = {
  brandId?: string | null;
  projectId?: string | null;
  workflowId?: string;
  runStepId?: string;
  /** Brand kit context for LLM nodes — appended to prompts when "Apply Brand Voice" was used */
  brandVoice?: string;
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

/** Helper: store a fal.ai result image URL in Supabase Storage, return signed URL */
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
  const { cdnUrl } = await uploadFromUrl(remoteUrl, path);
  return cdnUrl || remoteUrl;
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
      const model = String(config.model ?? "anthropic/claude-3.5-haiku");
      const temperature = Number(config.temperature ?? 0.7);
      const context = inputs.context as string | undefined;
      const image = inputs.image as string | undefined;
      const brandSuffix = ctx.brandVoice ? `\n\nBrand voice:\n${ctx.brandVoice}` : "";
      const prompt = context
        ? `Context:\n${context}\n\nTask:\n${instructions}${brandSuffix}`
        : `${instructions}${brandSuffix}`;
      const text = await falLLM(prompt, model, temperature, image);
      return {
        outputs: { text },
        costUsd: estimateCost("any-llm"),
        durationMs: Date.now() - t0,
      };
    }

    case "adAnalysis": {
      const instructions = String(config.instructions ?? "");
      const model = String(config.model ?? "anthropic/claude-3.5-sonnet");
      const temperature = Number(config.temperature ?? 0.4);
      const description = inputs.description as string | undefined;
      const image = inputs.image as string | undefined;
      const parts = [instructions];
      if (description) parts.push(`Description: ${description}`);
      const text = await falLLM(parts.join("\n\n"), model, temperature, image);
      return { outputs: { analysis: text }, costUsd: estimateCost("any-llm"), durationMs: Date.now() - t0 };
    }

    // ─────────────────────── IMAGE
    case "imageGen": {
      const prompt = String(config.instructions || inputs.prompt || "").trim();
      if (!prompt) throw new Error("Provide a prompt (input or instructions)");
      const model = String(config.model ?? "fal-ai/flux/dev");
      const aspect = String(config.aspect ?? "1:1");
      const numResults = Math.max(1, Math.min(4, Number(config.num_results ?? 1)));

      const r = await falRun(model, {
        prompt,
        image_size: ASPECT_TO_SIZE[aspect] ?? "square_hd",
        num_images: numResults,
        enable_safety_checker: false,
      });

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
      const r = await falRun(model, { image_url: image, prompt: instr });
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

    // ─────────────────────── VIDEO
    case "videoGen": {
      const prompt = String(config.instructions || inputs.prompt || "cinematic slow zoom");
      const model = String(config.model ?? "fal-ai/kling-video/v3/standard/image-to-video");
      const duration = String(config.duration ?? "5");
      const aspect = String(config.aspect ?? "9:16");
      const generateAudio = Boolean(config.generate_audio);
      const isImg2Vid = model.includes("image-to-video") || model.includes("/v3-omni");
      const startFrame = (inputs.start_frame ?? inputs.image) as string | undefined;
      const endFrame = inputs.end_frame as string | undefined;
      const reference = inputs.reference as string | undefined;

      if (isImg2Vid && !startFrame) throw new Error("This model needs a start frame image");

      const payload: Record<string, unknown> = {
        prompt,
        duration,
        aspect_ratio: aspect,
      };
      if (startFrame) payload.image_url = startFrame;
      if (endFrame) {
        // Different model families name this differently
        payload.tail_image_url = endFrame; // Kling
        payload.end_image_url = endFrame; // some models
      }
      if (reference) payload.reference_image_url = reference;
      if (model.includes("veo3")) payload.generate_audio = generateAudio;

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
