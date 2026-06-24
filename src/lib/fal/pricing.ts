// Pure cost-estimation helpers — NO server-only imports so this is safe to
// import from client components (e.g. the canvas workflow-cost estimate).
export function estimateCost(modelId: string, params: { duration?: number; numImages?: number; resolution?: string } = {}): number {
  const id = modelId.toLowerCase();
  const numImg = params.numImages ?? 1;
  const dur = params.duration ?? 1;
  const hi = (params.resolution ?? "").includes("1080") || (params.resolution ?? "").includes("4k");

  // Direct Google / OpenAI generations run on our corporate API keys (Gemini /
  // OpenAI), NOT through fal billing. Exclude them from the fal cost tally.
  if (id.startsWith("google/") || id.startsWith("openai/")) return 0;

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
  // Seedance 2.0 on fal: ~$0.30/s (720p std), ~$0.24/s (fast), ~$0.68/s (1080p).
  if (id.includes("seedance")) return (hi ? 0.68 : id.includes("/fast/") ? 0.25 : 0.31) * dur;
  if (id.includes("veo3")) return (hi ? 0.6 : 0.4) * dur;
  if (id.includes("runway-gen3")) return 0.5 * dur;
  if (id.includes("hailuo")) return 0.25 * dur;
  if (id.includes("luma-dream")) return 0.18 * dur;

  if (id.includes("sync-lipsync") || id.includes("latentsync")) return 0.1;

  if (id.includes("elevenlabs/tts")) return 0.0001 * 100; // ~$0.01 per 1000 chars
  if (id.includes("elevenlabs/sound-effects")) return 0.02 * dur;
  if (id.includes("elevenlabs/music")) return 0.013 * dur; // ~$0.80/min
  if (id.includes("minimax-music")) return 0.02 * dur;
  if (id.includes("ace-step")) return 0.01 * dur;
  if (id.includes("stable-audio") || id.includes("cassetteai")) return 0.01 * dur;

  if (id.includes("any-llm")) return 0.001;
  if (id.includes("birefnet") || id.includes("rembg")) return 0.005;
  if (id.includes("upscaler") || id.includes("aura-sr") || id.includes("ccsr")) return 0.04;
  // Topaz on fal: video billed per output second (~$0.08/s at >1080p/4K, the
  // common case here); image upscale ~ other image ops.
  if (id.includes("topaz/upscale/video")) return 0.08 * dur;
  if (id.includes("topaz/upscale/image")) return 0.05;
  if (id.includes("face-swap") || id.includes("photomaker")) return 0.05;

  return 0.01; // default
}

