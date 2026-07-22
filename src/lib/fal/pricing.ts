// Pure cost-estimation helpers — NO server-only imports so this is safe to
// import from client components (e.g. the canvas workflow-cost estimate).
//
// UNIT PRICES VERIFIED against the real fal invoices of BOTH API keys for
// 2026-06-22 .. 2026-07-22 (CSV export, "unit_price" column). Where fal bills
// by a unit we cannot know upfront (Seedance tokens, LLM router units, TTS
// characters), the estimate uses an invoice-calibrated approximation and the
// comment says so. Update from fresh CSVs when fal changes list prices.
export function estimateCost(modelId: string, params: { duration?: number; numImages?: number; resolution?: string } = {}): number {
  const id = modelId.toLowerCase();
  const numImg = params.numImages ?? 1;
  const dur = params.duration ?? 1;
  const hi = (params.resolution ?? "").includes("1080") || (params.resolution ?? "").includes("4k");

  // Direct Google / OpenAI generations run on our corporate API keys (Gemini /
  // OpenAI), NOT through fal billing. Excluded here; the admin dashboard
  // tracks them separately with their own estimates (src/lib/adminPricing.ts).
  if (id.startsWith("google/") || id.startsWith("openai/")) return 0;

  // ─── Images (invoice: $/image unless noted) ───────────────────────────────
  if (id.includes("nano-banana-pro")) return 0.15 * numImg;
  if (id.includes("nano-banana-2")) return 0.08 * numImg;
  if (id.includes("nano-banana")) return 0.039 * numImg;
  if (id.includes("grok-imagine-image")) return 0.02 * numImg;
  if (id.includes("flux-2-flex")) return 0.05 * numImg;          // $0.05/processed MP, ~1MP per image
  if (id.includes("flux/schnell")) return 0.003 * numImg;
  if (id.includes("flux/dev")) return 0.025 * numImg;
  if (id.includes("flux-pro/v1.1-ultra")) return 0.06 * numImg;
  if (id.includes("flux-pro/v1.1")) return 0.04 * numImg;
  if (id.includes("flux-pro/kontext/max")) return 0.08 * numImg;
  if (id.includes("flux-pro/kontext")) return 0.04 * numImg;
  if (id.includes("imagen4") && id.includes("ultra")) return 0.06 * numImg;
  if (id.includes("imagen4")) return 0.04 * numImg;
  if (id.includes("recraft")) return 0.04 * numImg;
  if (id.includes("ideogram")) return 0.04 * numImg;
  if (id.includes("stable-diffusion")) return 0.025 * numImg;
  if (id.includes("face-swap")) return 0.001 * numImg;
  if (id.includes("sam-3")) return 0.005;

  // ─── Video (invoice: $/output second) ─────────────────────────────────────
  // Kling: V3 and O3 bill $0.14/s on BOTH pro and standard (invoice-confirmed);
  // 4k tier not present in our invoices - kept at fal's listed $0.42/s.
  if (id.includes("kling-video") && id.includes("motion-control")) return (id.includes("/pro/") ? 0.168 : 0.14) * dur;
  if (id.includes("kling-video") && id.includes("/4k/")) return 0.42 * dur;
  if (id.includes("kling-video") && id.includes("master")) return 0.28 * dur;
  if (id.includes("kling-video") && id.includes("reference-to-video")) return 0.112 * dur;
  if (id.includes("kling-video") && id.includes("/video-to-video/")) return (id.includes("/standard/") ? 0.126 : 0.168) * dur;
  if (id.includes("kling-video")) return 0.14 * dur;
  // Seedance bills $0.014 per 1000 tokens; tokens ~ WxHxFPSxDUR. At 720p24
  // that lands near $0.30/s (fast ~$0.25, 1080p ~$0.68) - calibrated approx.
  if (id.includes("seedance")) return (hi ? 0.68 : id.includes("/fast/") ? 0.25 : 0.31) * dur;
  if (id.includes("veo3.1/fast") || id.includes("veo3/fast")) return 0.15 * dur;
  if (id.includes("veo3")) return 0.4 * dur;
  if (id.includes("grok-imagine-video")) return 0.05 * dur;
  if (id.includes("topaz/upscale/video")) return 0.01 * dur;
  if (id.includes("topaz/upscale/image")) return 0.05;
  if (id.includes("runway-gen3") || id.includes("runway-gen4")) return 0.5 * dur;
  if (id.includes("hailuo")) return 0.25 * dur;
  if (id.includes("luma-dream")) return 0.18 * dur;

  if (id.includes("sync-lipsync") || id.includes("latentsync")) return 0.1;

  // ─── Audio (invoice: music $0.8/min, sfx $0.002/s, voice-changer $0.3/min,
  //     TTS $0.10 (v3) / $0.05 (turbo) per 1000 characters) ──────────────────
  if (id.includes("elevenlabs/voice-changer")) return 0.30;      // <=1 min per run in practice
  if (id.includes("elevenlabs/tts/eleven-v3")) return 0.03;      // ~300 chars typical
  if (id.includes("elevenlabs/tts/turbo")) return 0.015;
  if (id.includes("elevenlabs/tts")) return 0.03;
  if (id.includes("elevenlabs/sound-effects")) return 0.002 * dur;
  if (id.includes("elevenlabs/music")) return 0.0133 * dur;      // $0.8/min
  if (id.includes("minimax-music")) return 0.15;                 // $/audio
  if (id.includes("ace-step")) return 0.0002 * dur;
  if (id.includes("stable-audio") || id.includes("cassetteai")) return 0.0012 * dur;

  // ─── LLM / misc ────────────────────────────────────────────────────────────
  // openrouter/router bills $0.01/unit (token-derived); invoice average lands
  // near $0.012 per call across our text+vision usage.
  if (id.includes("any-llm") || id.includes("openrouter")) return 0.012;
  if (id.includes("birefnet") || id.includes("rembg")) return 0.005;
  if (id.includes("clarity-upscaler")) return 0.05;              // $0.03/MP, ~1.7MP typical
  if (id.includes("upscaler") || id.includes("aura-sr") || id.includes("ccsr")) return 0.05;

  return 0.01; // default
}
