// Direct OpenAI Images API client (GPT Image 2) — uses the user's own
// OPENAI_API_KEY instead of routing through fal. GPT Image models always
// return base64 in data[].b64_json (no URL response mode), so callers persist
// the bytes to Storage themselves.
//
// Docs: https://developers.openai.com/api/reference/resources/images

const GENERATIONS_URL = "https://api.openai.com/v1/images/generations";
const EDITS_URL = "https://api.openai.com/v1/images/edits";

export type OpenAIImageOpts = {
  model: string; // e.g. "gpt-image-2"
  size: string; // WIDTHxHEIGHT, both divisible by 16, ratio 1:3..3:1
  quality: string; // low | medium | high
  n: number; // 1..10
};

function apiKey(): string {
  const k = process.env.OPENAI_API_KEY;
  if (!k) throw new Error("OPENAI_API_KEY not set");
  return k;
}

function extractB64(data: unknown, what: string): string[] {
  const list = (data as { data?: { b64_json?: string }[] } | null)?.data ?? [];
  const out = list.map((d) => d.b64_json).filter((b): b is string => !!b);
  if (out.length === 0) throw new Error(`OpenAI returned no ${what} image data`);
  return out;
}

/** Text-to-image. Returns an array of base64-encoded PNG strings. */
export async function generateOpenAIImage(
  prompt: string,
  opts: OpenAIImageOpts,
): Promise<string[]> {
  const res = await fetch(GENERATIONS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey()}`,
    },
    body: JSON.stringify({
      model: opts.model,
      prompt,
      size: opts.size,
      quality: opts.quality,
      n: opts.n,
    }),
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`OpenAI images ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return extractB64(await res.json(), "generated");
}

/** Image edit with one or more reference images (multipart). The references
 *  are public URLs (our Storage CDN); we fetch each and attach it as a file
 *  part. Returns base64-encoded PNG strings. */
export async function editOpenAIImage(
  prompt: string,
  imageUrls: string[],
  opts: Omit<OpenAIImageOpts, "n">,
): Promise<string[]> {
  const form = new FormData();
  form.append("model", opts.model);
  form.append("prompt", prompt);
  form.append("size", opts.size);
  form.append("quality", opts.quality);
  for (let i = 0; i < imageUrls.length; i++) {
    const r = await fetch(imageUrls[i]);
    if (!r.ok) throw new Error(`Could not fetch reference image (${r.status})`);
    const blob = await r.blob();
    // GPT Image edit accepts an array of images via repeated `image[]` parts.
    form.append("image[]", blob, `ref_${i}.png`);
  }
  const res = await fetch(EDITS_URL, {
    method: "POST",
    // No explicit Content-Type — fetch sets the multipart boundary itself.
    headers: { Authorization: `Bearer ${apiKey()}` },
    body: form,
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`OpenAI image edit ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return extractB64(await res.json(), "edited");
}
