// Direct Google image generation via the user's own GEMINI_API_KEY (instead of
// fal). Two different Google APIs:
//   - Nano Banana (Gemini image models, e.g. gemini-3.1-flash-image,
//     gemini-3-pro-image-preview): multimodal LLMs that emit images via
//     :generateContent. Accept reference images as inline parts. Return base64
//     in candidates[0].content.parts[].inlineData.data.
//   - Imagen (imagen-4.0-generate-001 / -ultra): dedicated image models via
//     :predict. Return base64 in predictions[].bytesBase64Encoded.
//
// NOTE: Google has deprecated the Imagen 4 endpoints (shutdown mid-2026) and
// recommends migrating to the Gemini image ("Nano Banana") models.

const BASE = "https://generativelanguage.googleapis.com/v1beta/models";

function apiKey(): string {
  const k = process.env.GEMINI_API_KEY;
  if (!k) throw new Error("GEMINI_API_KEY not set");
  return k;
}

async function urlToInline(url: string): Promise<{ inline_data: { mime_type: string; data: string } }> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Could not fetch reference image (${r.status})`);
  const mime = r.headers.get("content-type") || "image/jpeg";
  const buf = Buffer.from(await r.arrayBuffer());
  return { inline_data: { mime_type: mime, data: buf.toString("base64") } };
}

/** Nano Banana (Gemini image model) via generateContent. Optional reference
 *  images are sent inline (edit/compose). Returns base64-encoded image(s). */
export async function generateGeminiImage(
  prompt: string,
  opts: { model: string; aspect: string; refImages?: string[] },
): Promise<string[]> {
  const parts: unknown[] = [{ text: prompt }];
  for (const url of opts.refImages ?? []) parts.push(await urlToInline(url));

  const body = {
    contents: [{ parts }],
    generationConfig: {
      responseModalities: ["TEXT", "IMAGE"],
      imageConfig: { aspectRatio: opts.aspect },
    },
  };
  const res = await fetch(`${BASE}/${opts.model}:generateContent?key=${apiKey()}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Gemini image ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const data = await res.json();
  const candParts = (data?.candidates?.[0]?.content?.parts ?? []) as {
    inlineData?: { data?: string };
    inline_data?: { data?: string };
  }[];
  const out: string[] = [];
  for (const p of candParts) {
    const inline = p.inlineData ?? p.inline_data;
    if (inline?.data) out.push(inline.data);
  }
  if (out.length === 0) throw new Error("Gemini returned no image data");
  return out;
}

/** Imagen via :predict. sampleCount up to 4 → one call returns N images.
 *  Returns base64-encoded image(s). */
export async function generateImagen(
  prompt: string,
  opts: { model: string; aspect: string; n: number },
): Promise<string[]> {
  const body = {
    instances: [{ prompt }],
    parameters: { sampleCount: opts.n, aspectRatio: opts.aspect },
  };
  const res = await fetch(`${BASE}/${opts.model}:predict?key=${apiKey()}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Imagen ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const data = await res.json();
  const preds = (data?.predictions ?? []) as { bytesBase64Encoded?: string }[];
  const out = preds.map((p) => p.bytesBase64Encoded).filter((b): b is string => !!b);
  if (out.length === 0) throw new Error("Imagen returned no image data");
  return out;
}
