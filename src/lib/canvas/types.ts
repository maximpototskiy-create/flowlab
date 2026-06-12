// Node catalog — full Step 4 spec.
// Mirrors creative-studio-v4 HTML prototype + structural nodes.
// Execution logic lives server-side in lib/engine/runners.ts.

export type Vec2 = { x: number; y: number };

export type PortKind = "image" | "video" | "audio" | "text" | "any";

export type Port = {
  name: string;
  type: PortKind;
  optional?: boolean;
  label?: string;
  // When true, this port accepts MANY incoming edges. The resolved input
  // value for this port becomes an array (`string[]`) instead of a single
  // value. Used for "reference images" inputs on imageGen/textGen so that
  // multimodal models (Nano Banana, GPT Image, vision LLMs) can receive
  // multiple images at once via a single visual port.
  multi?: boolean;
  // When set, this port is only visible/active when the node's config
  // satisfies the condition. Used by `videoGen` to show different ports
  // depending on `mode` (text/image/keyframes/references). Edges to
  // inactive ports are cleaned up automatically by Canvas when the
  // condition stops matching (see `updateNodeConfig`).
  // Read everywhere via `getActiveInputs(def, config)` — DO NOT iterate
  // `def.inputs` directly anymore (it includes inactive ports).
  activeWhen?: { field: string; values: string[] };
};

/** Return the subset of `def.inputs` that are active for the given config.
 *  A port with no `activeWhen` is always active.
 *
 *  Backward-compat rule: when the gating field is NOT present in config
 *  (i.e. a legacy node saved before `mode` existed), the port is treated
 *  as active. This way existing workflows with start_frame + end_frame
 *  edges keep rendering both ports and don't lose connections after the
 *  field was added. New nodes (created from the palette) always have
 *  `def.defaults[field]` populated, so they get proper filtering from
 *  the moment they appear on canvas.
 *
 *  This is the SINGLE entry point Canvas / Edges / executor / runners use
 *  to know which ports exist for a given node instance. */
export function getActiveInputs(
  def: NodeTypeDef | undefined,
  config: Record<string, unknown> | undefined,
): Port[] {
  if (!def) return [];
  return def.inputs.filter((p) => {
    if (!p.activeWhen) return true;
    const v = config?.[p.activeWhen.field];
    if (v === undefined || v === null) return true; // legacy node — show
    return p.activeWhen.values.includes(String(v));
  });
}

export type NodeCategory = "text" | "image" | "video" | "audio" | "structural" | "integration" | "tools";

export const CATEGORY_LABELS: Record<NodeCategory, string> = {
  text: "Text",
  image: "Image",
  video: "Video",
  audio: "Audio",
  structural: "Structural",
  integration: "Integration",
  tools: "Tools",
};

export const CATEGORY_DESC: Record<NodeCategory, string> = {
  text: "Generate messaging, scripts, and prompts for ads across formats.",
  image: "Create and modify static ad visuals and assets.",
  video: "Build, animate, and assemble video ads from scripts and scenes.",
  audio: "Generate voiceovers, music, and audio assets for video ads.",
  structural: "Define the shape of your ad — sections that map to AE comps.",
  integration: "Call external APIs and send webhooks.",
  tools: "Annotations and exports for your canvas.",
};

export const CATEGORY_COLORS: Record<NodeCategory, string> = {
  text: "#3b82f6",
  image: "#10b981",
  video: "#ec4899",
  audio: "#f97316",
  structural: "#8b5cf6",
  integration: "#a855f7",
  tools: "#facc15",
};

export const CATEGORY_ORDER: NodeCategory[] = [
  "text",
  "image",
  "video",
  "audio",
  "structural",
  "integration",
  "tools",
];

// ─────────────────────────────────────────────
// LLM models — via fal-ai/any-llm endpoint
// (Vision-capable models indicated by `vision: true`)
// ─────────────────────────────────────────────
// `vision: true` means the model is in fal's Vision wrapper dropdown
// (openrouter/router/vision endpoint). `vision: false` means text-only —
// `vision: true` means the model is in fal's Vision wrapper dropdown.
// `reasoning: true` means fal requires reasoning enabled for this model
// (it's a reasoning/thinking model — fal returns 400 "Reasoning is
// mandatory for this endpoint and cannot be disabled" otherwise).
// All entries below are VALIDATED against live fal responses (Maxim's
// model self-ID test, June 2026): each one returns its real identity
// or has a documented fix applied.
export const LLM_MODELS = [
  // ─── Anthropic ──────────────────────────────────────────────────────
  // All confirmed working: each replies "I am Claude by Anthropic".
  // Opus is text-only (not in Vision dropdown); Sonnet does both.
  { id: "anthropic/claude-opus-4.6", label: "Claude Opus 4.6 (text only) ⭐", vision: false },
  { id: "anthropic/claude-sonnet-4.6", label: "Claude Sonnet 4.6", vision: true },
  { id: "anthropic/claude-sonnet-4.5", label: "Claude Sonnet 4.5", vision: true },
  // ─── OpenAI ─────────────────────────────────────────────────────────
  // gpt-4o + gpt-4.1 confirmed working. gpt-oss-120b is a REASONING model
  // — fal rejects it with 400 unless reasoning:true is sent.
  { id: "openai/gpt-4o", label: "GPT-4o", vision: true },
  { id: "openai/gpt-4.1", label: "GPT-4.1 (text only)", vision: false },
  { id: "openai/gpt-oss-120b", label: "GPT OSS 120B (reasoning)", vision: false, reasoning: true },
  // ─── Google ─────────────────────────────────────────────────────────
  // gemini-2.5-flash confirmed working. gemini-3.1-pro-preview is a
  // REASONING model (needs reasoning:true). gemini-3-pro-preview and
  // gemini-3-flash-preview were REMOVED — fal returned "No endpoints
  // found" for them (don't exist on the wrapper).
  { id: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash", vision: true },
  { id: "google/gemini-3.1-pro-preview", label: "Gemini 3.1 Pro Preview (reasoning)", vision: false, reasoning: true },
  // ─── Meta ──────────────────────────────────────────────────────────
  { id: "meta-llama/llama-4-maverick", label: "Llama 4 Maverick (text only)", vision: false },
  // ─── Moonshot ──────────────────────────────────────────────────────
  { id: "moonshotai/kimi-k2.5", label: "Kimi K2.5", vision: true },
  // ─── Alibaba ───────────────────────────────────────────────────────
  { id: "qwen/qwen3-vl-235b-a22b-instruct", label: "Qwen3-VL 235B (vision)", vision: true },
  // ─── xAI ───────────────────────────────────────────────────────────
  // grok-4-fast was deprecated by xAI (fal returned a deprecation 400).
  // Switched to grok-4.3 as recommended.
  { id: "x-ai/grok-4.3", label: "Grok 4.3", vision: true },
];

/** Helper used by the runner — does this model accept image inputs on
 *  fal's openrouter/router/vision wrapper? Used to know whether to
 *  preserve the user's choice for vision calls or fall back to a known
 *  vision-capable Claude. */
export function isVisionCapable(modelId: string): boolean {
  const m = LLM_MODELS.find((x) => x.id === modelId);
  return m?.vision === true;
}

/** Helper used by the runner/client — does fal require reasoning enabled
 *  for this model? Reasoning models (gpt-oss, gemini-3.x-preview) return
 *  400 unless `reasoning: true` is in the request body. */
export function requiresReasoning(modelId: string): boolean {
  const m = LLM_MODELS.find((x) => x.id === modelId) as
    | { reasoning?: boolean }
    | undefined;
  return m?.reasoning === true;
}

// ─────────────────────────────────────────────
// Field schemas — what shows in node settings panel
// ─────────────────────────────────────────────
export type FieldDef =
  | { name: string; label: string; type: "text"; placeholder?: string }
  | { name: string; label: string; type: "textarea"; placeholder?: string; rows?: number }
  | { name: string; label: string; type: "textarea-mono"; placeholder?: string }
  | { name: string; label: string; type: "number"; min?: number; max?: number; step?: number }
  | { name: string; label: string; type: "select"; options: { value: string; label: string }[]; icon?: string }
  | { name: string; label: string; type: "toggle" };

// ─────────────────────────────────────────────
// Node type definitions — what's in the palette
// ─────────────────────────────────────────────
export type NodeTypeDef = {
  name: string;
  category: NodeCategory;
  icon: string; // lucide name
  description: string;
  inputs: Port[];
  outputs: Port[];
  /** Default values of config */
  defaults: Record<string, unknown>;
  /** Fields exposed in node UI (settings panel) */
  fields: FieldDef[];
  /** Field names to show as quick controls in collapsed node */
  quickFields?: string[];
  /** Primary textarea field name (in node body) */
  primaryField?: string;
  primaryLabel?: string;
  primaryPlaceholder?: string;
  /** Example chips */
  examples?: string[];
  starters?: string[];
  /** Custom node body (file uploads etc.) */
  custom?: "upload-image" | "upload-video" | "upload-audio" | "note" | "brand-assets" | "composer";
  /** Special: force expanded modal (no primary textarea) */
  forceExpanded?: boolean;
};

const ASPECT_OPTS = [
  { value: "1:1", label: "1:1 Square" },
  { value: "9:16", label: "9:16 Portrait" },
  { value: "16:9", label: "16:9 Landscape" },
  { value: "4:5", label: "4:5 Portrait" },
  { value: "3:4", label: "3:4 Portrait" },
];

const LLM_OPTS = LLM_MODELS.map((m) => ({ value: m.id, label: m.label }));

function llmFields(): FieldDef[] {
  return [
    { name: "model", label: "Model", type: "select", options: LLM_OPTS, icon: "settings" },
    { name: "temperature", label: "Temperature", type: "number", min: 0, max: 2, step: 0.1 },
    { name: "useBrandKit", label: "Use brand kit (voice + screenshots)", type: "toggle" },
  ];
}

function llmNode(opts: {
  name: string;
  icon: string;
  description: string;
  examples?: string[];
  starters?: string[];
  defaultInstructions: string;
  defaultModel?: string;
  defaultTemp?: number;
  inputs?: Port[];
  outputs?: Port[];
}): NodeTypeDef {
  return {
    name: opts.name,
    category: "text",
    icon: opts.icon,
    description: opts.description,
    inputs: opts.inputs ?? [
      { name: "context", type: "text", optional: true },
      // Multi-image input for vision-capable LLMs (Claude, GPT, Gemini).
      // Connect as many as you need via a single port; the runner passes
      // them as separate image_url message parts to the model.
      { name: "images", type: "image", optional: true, multi: true, label: "Images (multi, for vision)" },
    ],
    outputs: opts.outputs ?? [{ name: "text", type: "text" }],
    defaults: {
      instructions: opts.defaultInstructions,
      // Default = Claude Opus 4.6 (concrete slug, documented working on
      // fal's NATIVE openrouter/router wrapper that we switched to in
      // patch 5.3.2). Tilde-aliases didn't work — fal doesn't proxy them.
      model: opts.defaultModel ?? "anthropic/claude-opus-4.6",
      temperature: opts.defaultTemp ?? 0.7,
      // Brand kit voice + screenshots auto-attached by default. User can
      // flip OFF in expanded settings for off-brand experiments.
      useBrandKit: true,
    },
    fields: llmFields(),
    primaryField: "instructions",
    primaryLabel: "Instructions",
    primaryPlaceholder: "Write or paste text input here…",
    examples: opts.examples,
    starters: opts.starters,
    quickFields: ["model"],
  };
}

export const NODE_TYPES: Record<string, NodeTypeDef> = {
  // ═════════════════════════════════════════════ TEXT
  yourText: {
    name: "Your Text",
    category: "text",
    icon: "type",
    description: "Paste your brief, inputs, or any text to use in the workflow.",
    inputs: [],
    outputs: [{ name: "text", type: "text" }],
    defaults: { text: "" },
    fields: [],
    primaryField: "text",
    primaryLabel: "Your text",
    primaryPlaceholder: "Type or paste text…",
  },

  textGen: llmNode({
    name: "Text Generation",
    icon: "sparkles",
    description: "Generate headlines, copy, or ideas based on your inputs.",
    examples: ["Headline variations for fitness app"],
    starters: ["Write ad copy for…"],
    defaultInstructions: "Generate 3 punchy ad hooks (max 8 words each) for the app described in the context.",
  }),

  creativeBrief: llmNode({
    name: "Creative Brief",
    icon: "clipboard-list",
    description: "Turn insights into a testable ad concept with clear messaging and visuals.",
    examples: ["Meal planning app brief"],
    starters: ["Write a brief for…"],
    defaultInstructions: "Generate a creative brief: target audience, key insight, message, tone, visual direction, CTA.",
    defaultModel: "anthropic/claude-opus-4.6",
  }),

  adAnalysis: {
    name: "Ad Analysis",
    category: "text",
    icon: "file-search",
    description: "Analyse a winning ad creative — extract hook, structure, visual style.",
    inputs: [
      { name: "image", type: "image", optional: true },
      { name: "description", type: "text", optional: true },
    ],
    outputs: [{ name: "analysis", type: "text" }],
    defaults: {
      instructions: "Analyse the ad. Extract: 1) main hook 2) target emotion 3) visual style 4) what makes it work 5) ideas for variations.",
      // Was claude-sonnet-latest which doesn't exist on fal-OR wrapper.
      // Opus 4.6 is the top vision model now available there.
      model: "anthropic/claude-opus-4.6",
      temperature: 0.4,
    },
    fields: llmFields(),
    primaryField: "instructions",
    primaryLabel: "Instructions",
    examples: ["Reverse-engineer competitor ad"],
    quickFields: ["model"],
  },

  imageAdPrompt: llmNode({
    name: "Image Ad Prompt",
    icon: "megaphone",
    description: "Turn a concept into a detailed image-generation prompt.",
    examples: ["Premium hero shot prompt"],
    starters: ["Visualize as a static ad…"],
    defaultInstructions: "Convert the context into a detailed image generation prompt (≤80 words). Include subject, style, lighting, mood, composition.",
    defaultTemp: 0.8,
  }),

  adVariation: llmNode({
    name: "Ad Variation",
    icon: "copy",
    description: "Generate A/B test variations from a base hook or copy.",
    examples: ["5 headline variations"],
    starters: ["Make 5 versions of…"],
    defaultInstructions: "Generate 5 distinct variations from the context. Different angles: emotional, FOMO, social proof, contrarian, playful. One per line, no numbering.",
    defaultTemp: 1.0,
  }),

  videoScript: llmNode({
    name: "Video Script",
    icon: "scroll-text",
    description: "Write a short ad script with scene-by-scene structure.",
    examples: ["15s app demo script"],
    starters: ["Write a 15-second script…"],
    defaultInstructions: "Write a 15-second mobile ad script with: HOOK (0-3s), VALUE (3-10s), CTA (10-15s). Include voice-over and visual direction.",
  }),

  videoFramePrompt: llmNode({
    name: "Prompt for Video Frame",
    icon: "scan-eye",
    description: "Generate the first frame image prompt for a video ad.",
    examples: ["Opening frame for hook"],
    defaultInstructions: "Create a detailed first-frame image prompt for the video described in context. Focus on what grabs attention in 1 second.",
  }),

  videoAdPrompt: llmNode({
    name: "Video Ad Prompt",
    icon: "film",
    description: "Detailed motion prompt for video generation models.",
    examples: ["Cinematic reveal prompt"],
    defaultInstructions: "Write a detailed video generation prompt: subject, camera movement, lighting, mood, pacing. ≤80 words.",
  }),

  voiceoverScript: llmNode({
    name: "Voiceover Script",
    icon: "mic",
    description: "Voice-over copy timed for short-form video.",
    examples: ["15s VO for fitness app"],
    defaultInstructions: "Write a punchy 15-second voice-over script. Spoken style, no marketing speak. Aim for ~40 words.",
  }),

  musicPrompt: llmNode({
    name: "Music Prompt",
    icon: "notebook-pen",
    description: "Describe the music vibe for AI generation.",
    examples: ["Upbeat workout track"],
    defaultInstructions: "Describe a 10-second background music track for the ad: genre, tempo, mood, instruments. ≤30 words.",
  }),

  characterPrompt: llmNode({
    name: "Character Prompt",
    icon: "user",
    description: "Describe a character for consistent generation.",
    examples: ["Friendly app mascot"],
    defaultInstructions: "Describe a character for ad creatives: age, ethnicity, style, expression, clothing, vibe. Keep it consistent and ad-friendly.",
  }),

  // ═════════════════════════════════════════════ IMAGE
  imageGen: {
    name: "Image Generation",
    category: "image",
    icon: "image-plus",
    description: "Generate a new ad image from a prompt. Connect reference images for multimodal models (Nano Banana, GPT Image).",
    inputs: [
      { name: "prompt", type: "text", optional: true },
      // Multimodal: drop multiple reference images onto a single port. The
      // runner detects this and switches Nano Banana to the /edit endpoint
      // (which accepts up to 14 image_urls) automatically. For non-multimodal
      // models the references are ignored.
      { name: "images", type: "image", optional: true, multi: true, label: "Reference images (multi)" },
    ],
    outputs: [{ name: "image", type: "image" }],
    defaults: {
      instructions: "",
      model: "fal-ai/nano-banana-2",
      aspect: "1:1",
      num_results: 1,
      // Brand kit auto-inject is ON by default. Users can flip it OFF in
      // the expanded settings to generate something off-brand without
      // having to delete the brand or its kit. Has no effect when the
      // workflow isn't inside a brand, or when Brand Assets node is
      // wired upstream (explicit takes precedence).
      useBrandKit: true,
    },
    fields: [
      {
        name: "model",
        label: "Model",
        type: "select",
        icon: "settings",
        options: [
          { value: "fal-ai/nano-banana-2", label: "Nano Banana 2 ⭐ (Google Gemini 3.1 Flash)" },
          { value: "fal-ai/nano-banana-pro", label: "Nano Banana Pro (Gemini 3 Pro)" },
          { value: "fal-ai/flux-2-flex", label: "FLUX 2 Flex" },
          { value: "fal-ai/flux-pro/v1.1-ultra", label: "FLUX 1.1 Pro Ultra" },
          { value: "fal-ai/flux-pro/v1.1", label: "FLUX Pro 1.1" },
          { value: "fal-ai/flux/dev", label: "FLUX Dev" },
          { value: "fal-ai/flux/schnell", label: "FLUX Schnell (fast)" },
          { value: "fal-ai/imagen4/preview/ultra", label: "Imagen 4 Ultra" },
          { value: "fal-ai/imagen4/preview", label: "Imagen 4" },
          { value: "fal-ai/gpt-image-1/text-to-image/byok", label: "GPT Image 1" },
          { value: "fal-ai/recraft-v3", label: "Recraft V3" },
          { value: "fal-ai/ideogram/v3", label: "Ideogram V3" },
          { value: "fal-ai/ideogram/v2", label: "Ideogram V2" },
          { value: "fal-ai/stable-diffusion-v35-large", label: "SD 3.5 Large" },
        ],
      },
      { name: "aspect", label: "Aspect ratio", type: "select", options: ASPECT_OPTS },
      { name: "num_results", label: "Number of results in a run", type: "number", min: 1, max: 4, step: 1 },
      { name: "useBrandKit", label: "Auto-attach brand UI screenshots", type: "toggle" },
    ],
    primaryField: "instructions",
    primaryLabel: "Instructions",
    primaryPlaceholder: "Your prompt here…",
    examples: ["Static ad — earbuds"],
    starters: ["Lifestyle scene showing…"],
    quickFields: ["model", "aspect"],
  },

  imageResize: {
    name: "Image Resize",
    category: "image",
    icon: "maximize",
    description: "Smart-crop or extend an image to a new aspect ratio.",
    inputs: [{ name: "image", type: "image" }],
    outputs: [{ name: "image", type: "image" }],
    defaults: { aspect: "9:16", mode: "outpaint", instructions: "" },
    fields: [
      { name: "aspect", label: "Target aspect", type: "select", options: ASPECT_OPTS },
      {
        name: "mode",
        label: "Mode",
        type: "select",
        options: [
          { value: "outpaint", label: "Outpaint (AI)" },
          { value: "crop", label: "Crop (local)" },
        ],
      },
    ],
    primaryField: "instructions",
    primaryLabel: "Optional context for outpaint",
    primaryPlaceholder: "e.g. 'extend the cafe background naturally'",
    quickFields: ["aspect", "mode"],
  },

  elementChange: {
    name: "Element Change",
    category: "image",
    icon: "wand-sparkles",
    description: "Edit an element in an image — replace, add, restyle.",
    inputs: [
      { name: "image", type: "image" },
      { name: "instruction", type: "text", optional: true },
    ],
    outputs: [{ name: "image", type: "image" }],
    defaults: { instructions: "", model: "fal-ai/flux-pro/kontext" },
    fields: [
      {
        name: "model",
        label: "Model",
        type: "select",
        icon: "settings",
        options: [
          { value: "fal-ai/flux-pro/kontext", label: "FLUX Kontext" },
          { value: "fal-ai/flux-pro/kontext/max", label: "FLUX Kontext Max" },
          { value: "fal-ai/nano-banana-2/edit", label: "Nano Banana Edit" },
        ],
      },
    ],
    primaryField: "instructions",
    primaryLabel: "Edit instruction",
    examples: ["Replace background with neon city", "Add coffee cup on table"],
    quickFields: ["model"],
  },

  imageTranslation: {
    name: "Image Translation",
    category: "image",
    icon: "languages",
    description: "Translate text in an image while keeping the visual style.",
    inputs: [{ name: "image", type: "image" }],
    outputs: [{ name: "image", type: "image" }],
    defaults: { target_language: "Spanish", model: "fal-ai/flux-pro/kontext/max" },
    fields: [
      {
        name: "target_language",
        label: "Target language",
        type: "select",
        options: [
          "Spanish", "German", "French", "Portuguese", "Japanese", "Korean",
          "Chinese (Simplified)", "Arabic", "Russian", "Italian", "Turkish", "Polish",
        ].map((l) => ({ value: l, label: l })),
      },
      {
        name: "model",
        label: "Model",
        type: "select",
        icon: "settings",
        options: [
          { value: "fal-ai/flux-pro/kontext", label: "FLUX Kontext" },
          { value: "fal-ai/flux-pro/kontext/max", label: "FLUX Kontext Max" },
          { value: "fal-ai/nano-banana-2/edit", label: "Nano Banana Edit" },
        ],
      },
    ],
    quickFields: ["target_language", "model"],
  },

  productScreenPlacement: {
    name: "Product Screen Placement",
    category: "image",
    icon: "smartphone",
    description: "Place an app screenshot into a device frame with background and headline.",
    inputs: [
      { name: "screenshot", type: "image" },
      { name: "headline", type: "text", optional: true },
    ],
    outputs: [{ name: "composed", type: "image" }],
    defaults: { device: "iphone15pro", background: "gradient-purple", headline_position: "top" },
    fields: [
      {
        name: "device",
        label: "Device frame",
        type: "select",
        options: [
          { value: "iphone15pro", label: "iPhone 15 Pro" },
          { value: "iphone16promax", label: "iPhone 16 Pro Max" },
          { value: "pixel9pro", label: "Pixel 9 Pro" },
          { value: "no-frame", label: "No frame" },
        ],
      },
      {
        name: "background",
        label: "Background",
        type: "select",
        options: [
          { value: "gradient-purple", label: "Gradient Purple" },
          { value: "gradient-blue", label: "Gradient Blue" },
          { value: "gradient-warm", label: "Gradient Warm" },
          { value: "gradient-mint", label: "Gradient Mint" },
          { value: "solid-dark", label: "Solid Dark" },
          { value: "solid-light", label: "Solid Light" },
        ],
      },
      {
        name: "headline_position",
        label: "Headline position",
        type: "select",
        options: [
          { value: "top", label: "Top" },
          { value: "bottom", label: "Bottom" },
          { value: "overlay-bottom", label: "Overlay bottom" },
          { value: "none", label: "None" },
        ],
      },
    ],
    quickFields: ["device", "background"],
  },

  characterGen: {
    name: "Character Generation",
    category: "image",
    icon: "person-standing",
    description: "Generate a character image from description.",
    inputs: [{ name: "description", type: "text", optional: true }],
    outputs: [{ name: "character", type: "image" }],
    defaults: { instructions: "", model: "fal-ai/flux/dev", style: "photorealistic", aspect: "3:4" },
    fields: [
      {
        name: "model",
        label: "Model",
        type: "select",
        icon: "settings",
        options: [
          { value: "fal-ai/flux/schnell", label: "FLUX Schnell" },
          { value: "fal-ai/flux/dev", label: "FLUX Dev" },
          { value: "fal-ai/flux-pro/v1.1", label: "FLUX Pro 1.1" },
          { value: "fal-ai/imagen4/preview", label: "Imagen 4" },
        ],
      },
      {
        name: "style",
        label: "Style",
        type: "select",
        options: ["photorealistic", "3d render", "illustration", "cartoon", "anime"].map((v) => ({ value: v, label: v })),
      },
      { name: "aspect", label: "Aspect", type: "select", options: ASPECT_OPTS },
    ],
    primaryField: "instructions",
    primaryLabel: "Character description",
    quickFields: ["model", "style", "aspect"],
  },

  upscale: {
    name: "Upscale",
    category: "image",
    icon: "zoom-in",
    description: "Upscale an image to higher resolution.",
    inputs: [{ name: "image", type: "image" }],
    outputs: [{ name: "image", type: "image" }],
    defaults: { model: "fal-ai/clarity-upscaler", scale: 2 },
    fields: [
      {
        name: "model",
        label: "Model",
        type: "select",
        icon: "settings",
        options: [
          { value: "fal-ai/clarity-upscaler", label: "Clarity Upscaler" },
          { value: "fal-ai/aura-sr", label: "Aura SR" },
          { value: "fal-ai/ccsr", label: "CCSR" },
        ],
      },
      { name: "scale", label: "Scale", type: "number", min: 2, max: 4, step: 1 },
    ],
    quickFields: ["model", "scale"],
  },

  removeBg: {
    name: "Remove Background",
    category: "image",
    icon: "scissors",
    description: "Cleanly remove the background from an image.",
    inputs: [{ name: "image", type: "image" }],
    outputs: [{ name: "image", type: "image" }],
    defaults: { model: "fal-ai/birefnet" },
    fields: [
      {
        name: "model",
        label: "Model",
        type: "select",
        icon: "settings",
        options: [
          { value: "fal-ai/birefnet", label: "BiRefNet" },
          { value: "fal-ai/imageutils/rembg", label: "RemBG" },
        ],
      },
    ],
    quickFields: ["model"],
  },

  faceSwap: {
    name: "Face Swap",
    category: "image",
    icon: "drama",
    description: "Swap a face onto another image while preserving expression.",
    inputs: [
      { name: "source", type: "image", label: "Source (scene)" },
      { name: "face", type: "image", label: "Face image" },
    ],
    outputs: [{ name: "image", type: "image" }],
    defaults: { model: "fal-ai/face-swap" },
    fields: [
      {
        name: "model",
        label: "Model",
        type: "select",
        icon: "settings",
        options: [
          { value: "fal-ai/face-swap", label: "Face Swap" },
          { value: "fal-ai/photomaker", label: "PhotoMaker" },
        ],
      },
    ],
    quickFields: ["model"],
  },

  inpaint: {
    name: "Inpaint",
    category: "image",
    icon: "brush",
    description: "Fill or replace a region with new content.",
    inputs: [
      { name: "image", type: "image" },
      { name: "prompt", type: "text", optional: true },
    ],
    outputs: [{ name: "image", type: "image" }],
    defaults: { instructions: "", model: "fal-ai/flux-pro/kontext" },
    fields: [
      {
        name: "model",
        label: "Model",
        type: "select",
        icon: "settings",
        options: [
          { value: "fal-ai/flux-pro/kontext", label: "FLUX Kontext" },
          { value: "fal-ai/nano-banana-2/edit", label: "Nano Banana Edit" },
        ],
      },
    ],
    primaryField: "instructions",
    primaryLabel: "Inpaint instruction",
    quickFields: ["model"],
  },

  uploadImage: {
    name: "Upload Image",
    category: "image",
    icon: "file-image",
    description: "Upload your own image to use in the workflow.",
    inputs: [],
    outputs: [{ name: "image", type: "image" }],
    defaults: { dataUrl: "", filename: "", cdnUrl: "" },
    fields: [],
    custom: "upload-image",
  },

  // ─────────────────────── Brand Assets
  // Pulls UI screenshots from the current brand's Brand Kit and forwards
  // the user-selected subset to downstream nodes (LLM vision, Nano Banana
  // references, etc). When this node is present, IT takes precedence over
  // the automatic ctx.brandUiScreenshots injection — gives users explicit
  // control over which screenshots flow into a specific generation.
  brandAssets: {
    name: "Brand Assets",
    category: "image",
    icon: "package",
    description:
      "Pull UI screenshots from this brand's Brand Kit. Select which ones to forward as references for the next node.",
    inputs: [],
    outputs: [{ name: "images", type: "image" }],
    defaults: {
      // selected: array of CDN URLs the user picked. Empty by default —
      // when nothing is selected, the runner forwards ALL brand screenshots
      // (same as automatic injection).
      selected: [] as string[],
    },
    fields: [],
    custom: "brand-assets",
  },

  // ═════════════════════════════════════════════ VIDEO
  videoGen: {
    name: "Video Generation",
    category: "video",
    icon: "clapperboard",
    description:
      "Generate a video. Pick a Mode: Text (prompt only), Image (one start frame), Keyframes (start + end), or References (multiple reference images for style/elements).",
    // Ports are gated by `mode` via activeWhen. The UI (Canvas + Edges)
    // reads `getActiveInputs(def, node.config)` and only renders the
    // ports that match the current mode. When the user switches mode,
    // edges to ports that just became inactive are auto-cleaned in
    // Canvas.updateNodeConfig — no orphan edges left behind.
    //
    // Legacy nodes saved before `mode` existed have no config.mode at
    // all → getActiveInputs returns ALL ports (start, end, reference,
    // references) so existing edges and workflows keep working until
    // the user sets the field explicitly.
    inputs: [
      { name: "prompt", type: "text", optional: true },
      {
        name: "start_frame",
        type: "image",
        optional: true,
        label: "Start frame",
        activeWhen: { field: "mode", values: ["image", "keyframes", "multi-shot"] },
      },
      {
        name: "end_frame",
        type: "image",
        optional: true,
        label: "End frame (transition)",
        activeWhen: { field: "mode", values: ["keyframes"] },
      },
      // Source video for Video-to-Video mode (Kling O3 v2v/edit and
      // v2v/reference). The endpoint takes video_url + a text prompt that
      // references the video as @Video1, plus optional image references.
      {
        name: "source_video",
        type: "video",
        optional: true,
        label: "Source video",
        activeWhen: { field: "mode", values: ["video-to-video"] },
      },
      // Multi-port for References mode AND Video-to-Video mode. In v2v the
      // refs become `image_urls` (style/element references, max 4 when a
      // video is present per Kling O3 docs). In references mode they're the
      // primary input. Order is edge-creation order.
      {
        name: "references",
        type: "image",
        optional: true,
        multi: true,
        label: "References (multi, up to 4-7)",
        activeWhen: { field: "mode", values: ["references", "video-to-video"] },
      },
      // Legacy single `reference` port. Kept in the schema so existing
      // workflows that wired something to it before patch 5.1 don't
      // lose edges on load. activeWhen values is empty → NEW nodes
      // (which have config.mode set) never show this port. Legacy
      // nodes (no config.mode) still show it because of the backward-
      // compat rule in getActiveInputs.
      {
        name: "reference",
        type: "image",
        optional: true,
        label: "Reference / style (legacy)",
        activeWhen: { field: "mode", values: [] },
      },
    ],
    outputs: [{ name: "video", type: "video" }],
    defaults: {
      instructions: "",
      // Default mode = "image" — a single start_frame. Matches the most
      // common workflow (drop one image, animate it) and keeps the
      // simplest version of the node visible in the palette.
      mode: "image",
      // Multi-shot scenes — only consumed when mode === "multi-shot".
      // Each scene becomes one element of Kling's native `multi_prompt`
      // array, producing a SINGLE video with N scenes stitched together
      // server-side (not N separate runs). Format intentionally kept
      // simple: prompt + duration. Default seeds one empty scene so the
      // SceneBuilder UI has something to render on first open.
      scenes: [{ id: "scene-1", prompt: "", duration: "5" }],
      model: "fal-ai/kling-video/v3/pro/image-to-video",
      duration: "5",
      aspect: "9:16",
      // keep_audio — used only in video-to-video mode. Whether to preserve
      // the original audio track from the source video (Kling O3 v2v
      // endpoints default this to true).
      keep_audio: true,
    },
    fields: [
      {
        name: "mode",
        label: "Mode",
        type: "select",
        icon: "layers",
        options: [
          { value: "text", label: "Text to Video (prompt only)" },
          { value: "image", label: "Image to Video (1 start frame)" },
          { value: "keyframes", label: "Keyframes (start + end frame)" },
          { value: "references", label: "References (multi-image, up to 4-7)" },
          { value: "multi-shot", label: "Multi-shot (N scenes, 1 video)" },
          { value: "video-to-video", label: "Video to Video (edit / restyle source)" },
        ],
      },
      {
        name: "model",
        label: "Model",
        type: "select",
        icon: "settings",
        options: [
          // ─── Kling V3 (newest, confirmed on fal) ──────────────────────
          // V3 supports native multi_prompt (multi-shot) and elements
          // (frontal+reference image sets) — used by future patches.
          // NOTE: V3 i2v has generate_audio default=TRUE on fal side, so
          // runner sends explicit bool to honor the user toggle.
          { value: "fal-ai/kling-video/v3/pro/image-to-video", label: "Kling 3.0 Pro (I2V) ⭐" },
          { value: "fal-ai/kling-video/v3/standard/image-to-video", label: "Kling 3.0 Standard (I2V)" },
          { value: "fal-ai/kling-video/v3/pro/text-to-video", label: "Kling 3.0 Pro (T2V)" },
          { value: "fal-ai/kling-video/v3/standard/text-to-video", label: "Kling 3.0 Standard (T2V)" },
          { value: "fal-ai/kling-video/v3/4k/image-to-video", label: "Kling 3.0 4K (I2V)" },
          { value: "fal-ai/kling-video/v3/4k/text-to-video", label: "Kling 3.0 4K (T2V)" },
          // ─── Kling O3 (older flagship line, still on fal) ─────────────
          // O3 i2v uses `image_url` (not start_image_url like V3).
          // O3 reference-to-video accepts up to 4 image_urls + elements +
          // optional start/end frames — basis for the upcoming References
          // mode in patch 3. End frame field is `end_image_url` (not
          // tail_image_url, which is V2.1 legacy).
          { value: "fal-ai/kling-video/o3/pro/image-to-video", label: "Kling O3 Pro (I2V)" },
          { value: "fal-ai/kling-video/o3/standard/image-to-video", label: "Kling O3 Standard (I2V)" },
          { value: "fal-ai/kling-video/o3/pro/text-to-video", label: "Kling O3 Pro (T2V)" },
          { value: "fal-ai/kling-video/o3/standard/text-to-video", label: "Kling O3 Standard (T2V)" },
          { value: "fal-ai/kling-video/o3/pro/reference-to-video", label: "Kling O3 Pro (Reference)" },
          { value: "fal-ai/kling-video/o3/standard/reference-to-video", label: "Kling O3 Standard (Reference)" },
          { value: "fal-ai/kling-video/o3/4k/image-to-video", label: "Kling O3 4K (I2V)" },
          { value: "fal-ai/kling-video/o3/4k/text-to-video", label: "Kling O3 4K (T2V)" },
          { value: "fal-ai/kling-video/o3/4k/reference-to-video", label: "Kling O3 4K (Reference)" },
          // ─── Kling O3 Video-to-Video (mode: video-to-video) ───────────
          // edit: transforms source video guided by prompt + image refs
          //   (@Image1) + elements (@Element1). keep_audio default true.
          // reference: style-transfers from a reference video, preserving
          //   cinematic motion/camera. Both take video_url + prompt.
          { value: "fal-ai/kling-video/o3/pro/video-to-video/edit", label: "Kling O3 Pro (V2V Edit)" },
          { value: "fal-ai/kling-video/o3/standard/video-to-video/edit", label: "Kling O3 Standard (V2V Edit)" },
          { value: "fal-ai/kling-video/o3/pro/video-to-video/reference", label: "Kling O3 Pro (V2V Reference)" },
          { value: "fal-ai/kling-video/o3/standard/video-to-video/reference", label: "Kling O3 Standard (V2V Reference)" },
          // ─── Kling 2.5 Turbo ──────────────────────────────────────────
          { value: "fal-ai/kling-video/v2.5-turbo/pro/text-to-video", label: "Kling 2.5 Turbo Pro (T2V)" },
          // ─── Kling 2.1 (legacy, uses tail_image_url for end frame) ────
          { value: "fal-ai/kling-video/v2.1/master/text-to-video", label: "Kling 2.1 Master (T2V)" },
          { value: "fal-ai/kling-video/v2.1/master/image-to-video", label: "Kling 2.1 Master (I2V)" },
          { value: "fal-ai/kling-video/v2.1/pro/image-to-video", label: "Kling 2.1 Pro (I2V)" },
          // Seedance 2.0 (ByteDance) — confirmed model IDs
          { value: "bytedance/seedance-2.0/image-to-video", label: "Seedance 2.0 (I2V) ⭐" },
          { value: "bytedance/seedance-2.0/fast/image-to-video", label: "Seedance 2.0 Fast (I2V)" },
          { value: "bytedance/seedance-2.0/text-to-video", label: "Seedance 2.0 (T2V)" },
          { value: "bytedance/seedance-2.0/fast/text-to-video", label: "Seedance 2.0 Fast (T2V)" },
          { value: "bytedance/seedance-2.0/reference-to-video", label: "Seedance 2.0 Reference (multi-modal)" },
          // Veo 3.1 — Fast variants are CHEAPER per generation than Standard.
          // Image-to-video and first-last-frame have their own endpoints,
          // and EACH endpoint has a /fast variant. Doc:
          //   https://fal.ai/models/fal-ai/veo3.1/fast/image-to-video/api
          //   https://fal.ai/models/fal-ai/veo3.1/fast/first-last-frame-to-video/api
          { value: "fal-ai/veo3.1/fast", label: "Veo 3.1 Fast (T2V) ⭐" },
          { value: "fal-ai/veo3.1", label: "Veo 3.1 Standard (T2V)" },
          { value: "fal-ai/veo3.1/fast/image-to-video", label: "Veo 3.1 Fast (I2V) ⭐" },
          { value: "fal-ai/veo3.1/image-to-video", label: "Veo 3.1 Standard (I2V)" },
          { value: "fal-ai/veo3.1/fast/first-last-frame-to-video", label: "Veo 3.1 Fast (First-Last Frame)" },
          { value: "fal-ai/veo3.1/first-last-frame-to-video", label: "Veo 3.1 Standard (First-Last Frame)" },
          // Other video models
          { value: "fal-ai/minimax/hailuo-02/standard/image-to-video", label: "Hailuo 02 (I2V)" },
          { value: "fal-ai/luma-dream-machine/ray-2/image-to-video", label: "Ray 2 (I2V)" },
          { value: "fal-ai/pixverse/v6/image-to-video", label: "Pixverse V6 (I2V)" },
        ],
      },
      {
        name: "duration",
        label: "Duration (s)",
        type: "select",
        options: [
          // Veo 3.1 accepts ONLY 4/6/8. Kling accepts 5/10. Seedance 5-10.
          // Hailuo 5-10. Pixverse 5/8/15. The runner coerces per-model to
          // the nearest supported value (see runners.ts videoGen case).
          { value: "4", label: "4s (Veo)" },
          { value: "5", label: "5s (Kling/Seedance)" },
          { value: "6", label: "6s (Veo)" },
          { value: "8", label: "8s (Veo)" },
          { value: "10", label: "10s (Kling/Seedance)" },
          { value: "15", label: "15s (Pixverse)" },
        ],
      },
      {
        name: "aspect",
        label: "Aspect ratio",
        type: "select",
        options: [
          { value: "9:16", label: "9:16" },
          { value: "1:1", label: "1:1" },
          { value: "16:9", label: "16:9" },
        ],
      },
      { name: "generate_audio", label: "Generate audio (Veo only)", type: "toggle" },
      { name: "keep_audio", label: "Keep source audio (V2V only)", type: "toggle" },
    ],
    primaryField: "instructions",
    primaryLabel: "Instructions",
    primaryPlaceholder: "Your prompt here…",
    examples: ["Product 360° orbit"],
    starters: ["Animated background for…"],
    quickFields: ["mode", "model", "duration", "aspect"],
  },

  talkingHead: {
    name: "Talking Head",
    category: "video",
    icon: "video",
    description: "Lip-sync an audio track to a face video for UGC-style ads.",
    inputs: [
      { name: "video", type: "video" },
      { name: "audio", type: "audio" },
    ],
    outputs: [{ name: "video", type: "video" }],
    defaults: { model: "fal-ai/sync-lipsync" },
    fields: [
      {
        name: "model",
        label: "Model",
        type: "select",
        icon: "settings",
        options: [
          { value: "fal-ai/sync-lipsync", label: "Sync Lipsync" },
          { value: "fal-ai/latentsync", label: "LatentSync" },
        ],
      },
    ],
    quickFields: ["model"],
  },

  lipsync: {
    name: "Lipsync",
    category: "video",
    icon: "speech",
    description: "Sync mouth movements in any video to a new audio.",
    inputs: [
      { name: "video", type: "video" },
      { name: "audio", type: "audio" },
    ],
    outputs: [{ name: "video", type: "video" }],
    defaults: { model: "fal-ai/sync-lipsync" },
    fields: [
      {
        name: "model",
        label: "Model",
        type: "select",
        icon: "settings",
        options: [
          { value: "fal-ai/sync-lipsync", label: "Sync Lipsync" },
          { value: "fal-ai/latentsync", label: "LatentSync" },
        ],
      },
    ],
    quickFields: ["model"],
  },

  motionTransfer: {
    name: "Motion Transfer",
    category: "video",
    icon: "move-3d",
    description: "Apply motion from a reference video to a still image (Kling Motion Control).",
    inputs: [
      { name: "image", type: "image", label: "Target subject" },
      { name: "video", type: "video", label: "Reference motion" },
    ],
    outputs: [{ name: "video", type: "video" }],
    defaults: { model: "fal-ai/kling-video/v3/pro/image-to-video", prompt: "" },
    fields: [
      {
        name: "model",
        label: "Model",
        type: "select",
        icon: "settings",
        options: [
          { value: "fal-ai/kling-video/v3/pro/image-to-video", label: "Kling 3.0 Master ⭐" },
          { value: "fal-ai/kling-video/v2.1/master/image-to-video", label: "Kling 2.6 Master" },
          { value: "fal-ai/runway-gen4/image-to-video", label: "Runway Gen 4" },
        ],
      },
      { name: "prompt", label: "Extra prompt (optional)", type: "text" },
    ],
    quickFields: ["model"],
  },

  heygenVideo: {
    name: "HeyGen Avatar",
    category: "video",
    icon: "user-round",
    description: "Generate a talking-avatar video from a prompt/script via HeyGen (async, renders in minutes).",
    inputs: [{ name: "prompt", type: "text", optional: true }],
    outputs: [{ name: "video", type: "video" }],
    defaults: { instructions: "" },
    fields: [],
    primaryField: "instructions",
    primaryLabel: "Prompt / script",
    primaryPlaceholder: "A friendly presenter explaining our product launch in 30 seconds…",
    examples: ["A presenter introducing our app in 20 seconds"],
    starters: ["A spokesperson explaining…"],
  },

  uploadVideo: {
    name: "Upload Video",
    category: "video",
    icon: "file-video",
    description: "Drop a video file or paste a URL.",
    inputs: [],
    outputs: [{ name: "video", type: "video" }],
    defaults: { url: "", cdnUrl: "" },
    fields: [],
    custom: "upload-video",
  },

  // ═════════════════════════════════════════════ AUDIO
  voiceover: {
    name: "Voiceover",
    category: "audio",
    icon: "audio-lines",
    description: "Text-to-speech with selectable voices.",
    inputs: [{ name: "text", type: "text" }],
    outputs: [{ name: "audio", type: "audio" }],
    defaults: { voice: "Rachel", stability: 0.5, model: "fal-ai/elevenlabs/tts/eleven-v3" },
    fields: [
      {
        name: "model",
        label: "Model",
        type: "select",
        icon: "settings",
        options: [
          { value: "fal-ai/elevenlabs/tts/eleven-v3", label: "ElevenLabs v3 ⭐ (most expressive)" },
          { value: "fal-ai/elevenlabs/tts/multilingual-v2", label: "ElevenLabs Multilingual v2" },
          { value: "fal-ai/elevenlabs/tts/turbo-v2.5", label: "ElevenLabs Turbo v2.5 (fast)" },
        ],
      },
      {
        name: "voice",
        label: "Voice",
        type: "select",
        options: ["Rachel", "Adam", "Antoni", "Bella", "Domi", "Elli", "Josh", "Sam", "Arnold", "Charlie"].map(
          (v) => ({ value: v, label: v }),
        ),
      },
      { name: "stability", label: "Stability (0-1)", type: "number", min: 0, max: 1, step: 0.05 },
    ],
    quickFields: ["voice"],
  },

  musicGen: {
    name: "Music Generation",
    category: "audio",
    icon: "music",
    description: "Generate background music or jingles from a text prompt.",
    inputs: [{ name: "description", type: "text", optional: true }],
    outputs: [{ name: "audio", type: "audio" }],
    defaults: { instructions: "", model: "fal-ai/stable-audio", duration: 10 },
    fields: [
      {
        name: "model",
        label: "Model",
        type: "select",
        icon: "settings",
        options: [
          { value: "fal-ai/stable-audio", label: "Stable Audio" },
          { value: "fal-ai/cassetteai/music-generator", label: "Cassette AI" },
        ],
      },
      { name: "duration", label: "Duration (s)", type: "number", min: 1, max: 60, step: 1 },
    ],
    primaryField: "instructions",
    primaryLabel: "Music description",
    examples: ["Background music for product ad"],
    starters: ["Create a jingle for…"],
    quickFields: ["model", "duration"],
  },

  sfxGen: {
    name: "SFX Generation",
    category: "audio",
    icon: "bell-ring",
    description: "Generate a sound effect from a text prompt.",
    inputs: [{ name: "description", type: "text", optional: true }],
    outputs: [{ name: "audio", type: "audio" }],
    defaults: { instructions: "", model: "fal-ai/elevenlabs/sound-effects/v2", duration: 3 },
    fields: [
      {
        name: "model",
        label: "Model",
        type: "select",
        icon: "settings",
        options: [{ value: "fal-ai/elevenlabs/sound-effects/v2", label: "ElevenLabs SFX" }],
      },
      { name: "duration", label: "Duration (s)", type: "number", min: 1, max: 22, step: 1 },
    ],
    primaryField: "instructions",
    primaryLabel: "SFX description",
    quickFields: ["duration"],
  },

  uploadAudio: {
    name: "Upload Audio",
    category: "audio",
    icon: "file-audio",
    description: "Drop an audio file or paste a URL.",
    inputs: [],
    outputs: [{ name: "audio", type: "audio" }],
    defaults: { url: "", cdnUrl: "" },
    fields: [],
    custom: "upload-audio",
  },

  // ═════════════════════════════════════════════ STRUCTURAL
  hook: {
    name: "Hook",
    category: "structural",
    icon: "anchor",
    description: "Opening 0-3 seconds — designed to stop the scroll.",
    inputs: [
      { name: "video", type: "video", optional: true },
      { name: "image", type: "image", optional: true },
      { name: "audio", type: "audio", optional: true },
      { name: "text", type: "text", optional: true },
    ],
    outputs: [{ name: "section", type: "video" }],
    defaults: { label: "Hook" },
    fields: [{ name: "label", label: "Section label", type: "text" }],
  },
  body: {
    name: "Body",
    category: "structural",
    icon: "package",
    description: "Main content — value proposition or story.",
    inputs: [
      { name: "video", type: "video", optional: true },
      { name: "image", type: "image", optional: true },
      { name: "audio", type: "audio", optional: true },
      { name: "text", type: "text", optional: true },
    ],
    outputs: [{ name: "section", type: "video" }],
    defaults: { label: "Body" },
    fields: [{ name: "label", label: "Section label", type: "text" }],
  },
  packShot: {
    name: "Pack Shot",
    category: "structural",
    icon: "package-2",
    description: "Product/screen reveal moment.",
    inputs: [
      { name: "image", type: "image", optional: true },
      { name: "video", type: "video", optional: true },
    ],
    outputs: [{ name: "section", type: "video" }],
    defaults: { label: "Pack Shot" },
    fields: [{ name: "label", label: "Section label", type: "text" }],
  },
  cta: {
    name: "CTA",
    category: "structural",
    icon: "mouse-pointer-click",
    description: "Call-to-action ending.",
    inputs: [
      { name: "video", type: "video", optional: true },
      { name: "image", type: "image", optional: true },
      { name: "text", type: "text", optional: true },
    ],
    outputs: [{ name: "section", type: "video" }],
    defaults: { label: "CTA", text: "Download now" },
    fields: [
      { name: "label", label: "Section label", type: "text" },
      { name: "text", label: "CTA text", type: "text" },
    ],
  },
  scene: {
    name: "Scene",
    category: "structural",
    icon: "film",
    description: "Generic scene container — use for any section.",
    inputs: [
      { name: "video", type: "video", optional: true },
      { name: "image", type: "image", optional: true },
      { name: "audio", type: "audio", optional: true },
    ],
    outputs: [{ name: "section", type: "video" }],
    defaults: { label: "Scene" },
    fields: [{ name: "label", label: "Scene label", type: "text" }],
  },
  transition: {
    name: "Transition",
    category: "structural",
    icon: "arrow-right-left",
    description: "Transition between sections.",
    inputs: [
      { name: "from", type: "video" },
      { name: "to", type: "video" },
    ],
    outputs: [{ name: "video", type: "video" }],
    defaults: { kind: "cut" },
    fields: [
      {
        name: "kind",
        label: "Transition type",
        type: "select",
        options: ["cut", "crossfade", "wipe", "morph"].map((v) => ({ value: v, label: v })),
      },
    ],
  },
  logoReveal: {
    name: "Logo Reveal",
    category: "structural",
    icon: "badge-check",
    description: "Brand outro with logo animation.",
    inputs: [{ name: "logo", type: "image" }],
    outputs: [{ name: "video", type: "video" }],
    defaults: { duration: 2 },
    fields: [{ name: "duration", label: "Duration (s)", type: "number", min: 1, max: 5, step: 0.5 }],
  },

  // ═════════════════════════════════════════════ INTEGRATION
  customApi: {
    name: "Custom API",
    category: "integration",
    icon: "code",
    description: "Connect any HTTP API endpoint.",
    inputs: [{ name: "input", type: "any", optional: true }],
    outputs: [{ name: "output", type: "any" }],
    defaults: {
      url: "https://api.example.com/endpoint",
      method: "POST",
      headers: '{\n  "Content-Type": "application/json"\n}',
      body: '{\n  "prompt": "{{input}}"\n}',
      response_path: "",
    },
    fields: [
      { name: "url", label: "Endpoint URL", type: "text" },
      {
        name: "method",
        label: "HTTP method",
        type: "select",
        options: ["GET", "POST", "PUT", "PATCH", "DELETE"].map((v) => ({ value: v, label: v })),
      },
      { name: "headers", label: "Headers (JSON)", type: "textarea-mono" },
      { name: "body", label: "Body — {{input}} = upstream value", type: "textarea-mono" },
      { name: "response_path", label: "Response path (e.g. data.0.url)", type: "text" },
    ],
    forceExpanded: true,
  },

  webhook: {
    name: "Webhook (out)",
    category: "integration",
    icon: "webhook",
    description: "POST result to Slack, Discord, Zapier, or your dashboard.",
    inputs: [{ name: "payload", type: "any" }],
    outputs: [{ name: "response", type: "any" }],
    defaults: { url: "", method: "POST" },
    fields: [
      { name: "url", label: "Webhook URL", type: "text" },
      {
        name: "method",
        label: "Method",
        type: "select",
        options: [
          { value: "POST", label: "POST" },
          { value: "PUT", label: "PUT" },
        ],
      },
    ],
  },

  // ═════════════════════════════════════════════ TOOLS
  note: {
    name: "Note",
    category: "tools",
    icon: "sticky-note",
    description: "Pin a note on the canvas — for context, todos, or labels.",
    inputs: [],
    outputs: [],
    defaults: { text: "A note for your team…" },
    fields: [],
    primaryField: "text",
    primaryLabel: "Note",
    custom: "note",
  },

  output: {
    name: "Output / Preview",
    category: "tools",
    icon: "monitor",
    description: "Final preview pane — connect any result here.",
    inputs: [{ name: "result", type: "any" }],
    outputs: [],
    defaults: {},
    fields: [],
  },

  composer: {
    name: "Composer",
    category: "video",
    icon: "clapperboard",
    description: "Collect connected clips, images, audio and text into timeline layers and open them in the browser editor.",
    inputs: [{ name: "tracks", type: "any", multi: true, label: "Tracks" }],
    outputs: [],
    defaults: {},
    fields: [],
    custom: "composer",
  },

  exportMP4: {
    name: "Export MP4",
    category: "tools",
    icon: "download",
    description: "Export composed video as MP4 file.",
    inputs: [
      { name: "video", type: "video" },
      { name: "audio", type: "audio", optional: true },
    ],
    outputs: [],
    defaults: { quality: "1080p" },
    fields: [
      {
        name: "quality",
        label: "Quality",
        type: "select",
        options: [
          { value: "720p", label: "720p" },
          { value: "1080p", label: "1080p" },
          { value: "4k", label: "4K" },
        ],
      },
    ],
  },

  exportAE: {
    name: "Export to AE",
    category: "tools",
    icon: "layers",
    description: "Package assets + metadata for After Effects.",
    inputs: [
      { name: "video", type: "video", optional: true },
      { name: "audio", type: "audio", optional: true },
    ],
    outputs: [],
    defaults: {},
    fields: [],
  },

  exportImage: {
    name: "Export Image",
    category: "tools",
    icon: "image-down",
    description: "Save image as PNG/JPG.",
    inputs: [{ name: "image", type: "image" }],
    outputs: [],
    defaults: { format: "png" },
    fields: [
      {
        name: "format",
        label: "Format",
        type: "select",
        options: [
          { value: "png", label: "PNG" },
          { value: "jpg", label: "JPG" },
        ],
      },
    ],
  },

  exportAudio: {
    name: "Export Audio",
    category: "tools",
    icon: "music-2",
    description: "Save audio as MP3/WAV.",
    inputs: [{ name: "audio", type: "audio" }],
    outputs: [],
    defaults: { format: "mp3" },
    fields: [
      {
        name: "format",
        label: "Format",
        type: "select",
        options: [
          { value: "mp3", label: "MP3" },
          { value: "wav", label: "WAV" },
        ],
      },
    ],
  },
};

// ─────────────────────────────────────────────
// Graph types
// ─────────────────────────────────────────────
export type GraphNode = {
  id: string;
  type: string;
  position: Vec2;
  config: Record<string, unknown>;
  // Runtime/UI state (not persisted)
  status?: "idle" | "pending" | "running" | "done" | "error";
  outputs?: Record<string, unknown>;
  error?: string;
  costUsd?: number;
  durationMs?: number;
  /** Multi-result: list of output URLs/values when num_results > 1 */
  results?: { value: string; mime?: string }[];
  /** Currently selected result index (for multi-result nodes) */
  selectedResult?: number;
};

export type GraphEdge = {
  id: string;
  from: { nodeId: string; port: string };
  to: { nodeId: string; port: string };
};

// A visual grouping of nodes — drawn as a labelled box behind them. Purely
// organisational: dragging the box moves all members, clicking it selects
// them. Optional on Graph so existing graphs (saved before groups existed)
// keep working untouched.
export type Group = {
  id: string;
  nodeIds: string[];
  label?: string;
  /** Accent colour key (see GROUP_COLORS in Canvas). Defaults to brand. */
  color?: string;
};

export type Graph = { nodes: GraphNode[]; edges: GraphEdge[]; groups?: Group[] };

export const EMPTY_GRAPH: Graph = { nodes: [], edges: [] };

export function makeNode(type: string, position: Vec2): GraphNode {
  const def = NODE_TYPES[type];
  if (!def) throw new Error(`Unknown node type: ${type}`);
  return {
    id: `n_${Math.random().toString(36).slice(2, 10)}`,
    type,
    position,
    config: structuredClone(def.defaults),
  };
}

export function makeEdge(fromNode: string, fromPort: string, toNode: string, toPort: string): GraphEdge {
  return {
    id: `e_${Math.random().toString(36).slice(2, 10)}`,
    from: { nodeId: fromNode, port: fromPort },
    to: { nodeId: toNode, port: toPort },
  };
}

export function portsCompatible(out: PortKind, inp: PortKind): boolean {
  if (out === inp) return true;
  if (out === "any" || inp === "any") return true;
  return false;
}

/** Look up whether a given (nodeType, portName) pair is declared as a
 *  multi-port. Multi-ports accept many incoming edges and don't dedup. */
export function isMultiInputPort(nodeType: string, portName: string): boolean {
  const def = NODE_TYPES[nodeType];
  if (!def) return false;
  const port = def.inputs.find((p) => p.name === portName);
  return Boolean(port?.multi);
}

/** Return a new edges array with `newEdge` appended.
 *
 * For single (non-multi) target ports, any existing edge to that same
 * (toNode, toPort) is replaced. For multi target ports, we just append —
 * but de-duplicate by (fromNode, fromPort) so the user can't accidentally
 * connect the same source twice. */
export function addEdgeRespectingMulti(
  edges: GraphEdge[],
  newEdge: GraphEdge,
  graph: { nodes: GraphNode[] },
): GraphEdge[] {
  const toNode = graph.nodes.find((n) => n.id === newEdge.to.nodeId);
  if (!toNode) return [...edges, newEdge];
  const multi = isMultiInputPort(toNode.type, newEdge.to.port);
  if (multi) {
    // Prevent duplicate source on the same target multi-port.
    const dup = edges.some(
      (e) =>
        e.to.nodeId === newEdge.to.nodeId &&
        e.to.port === newEdge.to.port &&
        e.from.nodeId === newEdge.from.nodeId &&
        e.from.port === newEdge.from.port,
    );
    if (dup) return edges;
    return [...edges, newEdge];
  }
  // Single port: classic replace-on-collision behaviour.
  return [
    ...edges.filter((e) => !(e.to.nodeId === newEdge.to.nodeId && e.to.port === newEdge.to.port)),
    newEdge,
  ];
}

// ─────────────────────────────────────────────
// Quick actions — top section of palette
// ─────────────────────────────────────────────
export type QuickAction = { id: string; label: string; icon: string; type: string; group: "generate" | "add" };

export const QUICK_ACTIONS: QuickAction[] = [
  { id: "qa-gen-text", label: "Text", icon: "sparkles", type: "textGen", group: "generate" },
  { id: "qa-gen-image", label: "Image", icon: "image-plus", type: "imageGen", group: "generate" },
  { id: "qa-gen-video", label: "Video", icon: "clapperboard", type: "videoGen", group: "generate" },
  { id: "qa-gen-voice", label: "Voice", icon: "audio-lines", type: "voiceover", group: "generate" },
  { id: "qa-gen-music", label: "Music", icon: "music", type: "musicGen", group: "generate" },
  { id: "qa-add-text", label: "Text", icon: "type", type: "yourText", group: "add" },
  { id: "qa-add-image", label: "Image", icon: "file-image", type: "uploadImage", group: "add" },
  { id: "qa-add-video", label: "Video", icon: "file-video", type: "uploadVideo", group: "add" },
  { id: "qa-add-audio", label: "Audio", icon: "file-audio", type: "uploadAudio", group: "add" },
  { id: "qa-add-note", label: "Note", icon: "sticky-note", type: "note", group: "add" },
];

// Port-kind to category color (for visual edge coloring)
export const PORT_COLORS: Record<PortKind, string> = {
  text: "#3b82f6",
  image: "#10b981",
  video: "#ec4899",
  audio: "#f97316",
  any: "#facc15",
};
