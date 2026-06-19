// ─────────────────────────────────────────────────────────────────────────
// Agent LLM router
//
// Single entry point for all agent calls. Routes by task to the provider that
// fits best, using the user's own keys (OPENAI_API_KEY / GEMINI_API_KEY):
//
//   • research  → Gemini  (native Google Search grounding = live web)
//   • generate  → OpenAI  (strong structured / JSON output)
//   • chat      → Gemini  (cheap, fast default)
//
// You can also force a provider per call. Returns plain text plus, for
// grounded research, any source URLs Gemini cited.
// ─────────────────────────────────────────────────────────────────────────

export type AgentTask = "research" | "generate" | "chat";
export type Provider = "openai" | "gemini";

export type AgentCall = {
  task: AgentTask;
  system?: string;
  user: string;
  provider?: Provider; // optional override
  webSearch?: boolean; // force web search on/off (default: on for research)
  json?: boolean; // ask for JSON-only output (generate)
  temperature?: number;
  model?: string; // explicit model override (else the task default)
  images?: string[]; // image URLs for multimodal/vision calls
};

export type AgentResult = {
  text: string;
  provider: Provider;
  model: string;
  sources?: { title?: string; url: string }[];
};

const OPENAI_MODEL = "gpt-5.5";
const GEMINI_MODEL = "gemini-3.5-flash";

function pickProvider(task: AgentTask): Provider {
  if (task === "generate") return "openai";
  return "gemini"; // research + chat
}

export async function callAgent(call: AgentCall): Promise<AgentResult> {
  const provider = call.provider ?? pickProvider(call.task);
  if (provider === "openai") return callOpenAI(call);
  return callGemini(call);
}

// ── OpenAI (chat completions) ──────────────────────────────────────────────
async function callOpenAI(call: AgentCall): Promise<AgentResult> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY not set");
  const model = call.model ?? OPENAI_MODEL;

  // Vision: when images are supplied, send the user turn as multimodal content
  // (OpenAI fetches each image_url directly — our URLs are public CDN links).
  const userContent: unknown =
    call.images && call.images.length
      ? [
          { type: "text", text: call.user },
          ...call.images.map((url) => ({ type: "image_url", image_url: { url } })),
        ]
      : call.user;

  // gpt-5.x are reasoning models — don't send temperature (not supported).
  const body: Record<string, unknown> = {
    model,
    messages: [
      ...(call.system ? [{ role: "system", content: call.system }] : []),
      { role: "user", content: userContent },
    ],
  };
  if (call.json) body.response_format = { type: "json_object" };

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`OpenAI ${res.status}: ${t.slice(0, 300)}`);
  }
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content ?? "";
  return { text, provider: "openai", model };
}

// ── Gemini (generateContent, with optional Google Search grounding) ─────────
async function callGemini(call: AgentCall): Promise<AgentResult> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY not set");
  const model = call.model ?? GEMINI_MODEL;
  const useSearch = call.webSearch ?? call.task === "research";

  // Vision: Gemini generateContent needs inline image BYTES (base64), not URLs,
  // so fetch each reference and inline it alongside the text part.
  const imageParts =
    call.images && call.images.length
      ? await Promise.all(call.images.map(urlToInlineData))
      : [];

  // Gemini 3.x reasoning — keep default sampling (don't set temperature).
  const body: Record<string, unknown> = {
    contents: [{ role: "user", parts: [{ text: call.user }, ...imageParts] }],
    ...(call.json ? { generationConfig: { responseMimeType: "application/json" } } : {}),
  };
  if (call.system) {
    body.systemInstruction = { parts: [{ text: call.system }] };
  }
  // Google Search grounding (live web) — can't combine with JSON mode.
  if (useSearch && !call.json) {
    body.tools = [{ google_search: {} }];
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Gemini ${res.status}: ${t.slice(0, 300)}`);
  }
  const data = await res.json();
  const cand = data.candidates?.[0];
  const text =
    cand?.content?.parts?.map((p: { text?: string }) => p.text || "").join("") ?? "";

  // Extract grounding sources, if any.
  let sources: { title?: string; url: string }[] | undefined;
  const chunks = cand?.groundingMetadata?.groundingChunks as
    | Array<{ web?: { uri?: string; title?: string } }>
    | undefined;
  if (chunks?.length) {
    sources = chunks
      .map((c) => c.web)
      .filter((w): w is { uri: string; title?: string } => !!w?.uri)
      .map((w) => ({ url: w.uri, title: w.title }));
  }

  return { text, provider: "gemini", model, sources };
}

// Fetch an image URL and inline it as Gemini base64 image bytes.
async function urlToInlineData(
  url: string,
): Promise<{ inline_data: { mime_type: string; data: string } }> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Could not fetch image for vision (${r.status})`);
  const mime = r.headers.get("content-type") || "image/jpeg";
  const buf = Buffer.from(await r.arrayBuffer());
  return { inline_data: { mime_type: mime, data: buf.toString("base64") } };
}

// Direct LLM call for first-party OpenAI / Gemini node models — routed through
// the user's own OPENAI_API_KEY / GEMINI_API_KEY instead of fal's OpenRouter
// wrapper. `modelId` is the node model id, e.g. "openai/gpt-5.5" or
// "google/gemini-3.5-flash"; provider + API model name are derived from it.
export async function directLLM(
  modelId: string,
  prompt: string,
  images: string[] = [],
  systemPrompt?: string,
): Promise<string> {
  const provider: Provider = modelId.startsWith("openai/") ? "openai" : "gemini";
  const apiModel = modelId.split("/").slice(1).join("/");
  const res = await callAgent({
    task: "generate",
    provider,
    model: apiModel,
    system: systemPrompt,
    user: prompt,
    images,
  });
  return res.text;
}
