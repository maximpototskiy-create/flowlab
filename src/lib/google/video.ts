// Direct Google Veo video client — uses the user's own GEMINI_API_KEY against
// the Gemini API (generativelanguage), bypassing fal. Veo generation is a
// long-running operation: submit -> poll the operation -> download the mp4 from
// the returned (auth-gated) URI. We download the bytes here (with the API key
// header) because the URI can't be fetched anonymously, so persistAsset's
// uploadFromUrl won't work — callers persist the returned Buffer instead.
//
// Docs: https://ai.google.dev/gemini-api/docs/video
import { fetchWithRetry } from "@/lib/fetchRetry";

const BASE = "https://generativelanguage.googleapis.com/v1beta";

function apiKey(): string {
  const k = process.env.GEMINI_API_KEY;
  if (!k) throw new Error("GEMINI_API_KEY not set");
  return k;
}

// Fetch an image URL and return it as a Veo predict image part. The
// predictLongRunning (predict) schema expects { bytesBase64Encoded, mimeType } —
// NOT the generateContent-style inlineData (which the Fast model rejects).
async function urlToImagePart(url: string): Promise<{ bytesBase64Encoded: string; mimeType: string }> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Veo: failed to fetch input image (${res.status})`);
  const mimeType = res.headers.get("content-type")?.split(";")[0] || "image/png";
  const bytesBase64Encoded = Buffer.from(await res.arrayBuffer()).toString("base64");
  return { bytesBase64Encoded, mimeType };
}

export type VeoOpts = {
  model: string; // "veo-3.1-generate-preview" | "veo-3.1-fast-generate-preview"
  prompt: string;
  aspect?: string; // "16:9" | "9:16"
  resolution?: string; // "720p" | "1080p" | "4k" (4k not on Fast)
  imageUrl?: string; // start frame -> image-to-video
  lastFrameUrl?: string; // end frame -> first/last-frame mode
  negativePrompt?: string;
};

// Generates a single video and returns the raw mp4 bytes. Throws on failure or
// timeout (the latter to stay under the serverless function's wall-clock limit).
export async function generateVeoVideo(opts: VeoOpts): Promise<Buffer> {
  const key = apiKey();

  // predictLongRunning uses { bytesBase64Encoded, mimeType } for image inputs.
  const instance: Record<string, unknown> = { prompt: opts.prompt };
  if (opts.imageUrl) instance.image = await urlToImagePart(opts.imageUrl);
  if (opts.lastFrameUrl) instance.lastFrame = await urlToImagePart(opts.lastFrameUrl);

  // Note: this model rejects `numberOfVideos`, so we don't send it (1 by default).
  const parameters: Record<string, unknown> = {};
  if (opts.aspect) parameters.aspectRatio = opts.aspect;
  if (opts.resolution) parameters.resolution = opts.resolution;
  if (opts.negativePrompt) parameters.negativePrompt = opts.negativePrompt;

  // 1) Submit the long-running generation.
  const submit = await fetchWithRetry(`${BASE}/models/${opts.model}:predictLongRunning`, {
    method: "POST",
    headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({ instances: [instance], parameters }),
  });
  if (!submit.ok) {
    throw new Error(`Veo submit ${submit.status}: ${(await submit.text()).slice(0, 300)}`);
  }
  const opName = ((await submit.json()) as { name?: string }).name;
  if (!opName) throw new Error("Veo: submit returned no operation name");

  // 2) Poll until done. Veo takes ~1-3 min; cap below the function timeout.
  const startedAt = Date.now();
  const maxMs = 280_000;
  let videoUri: string | undefined;
  for (;;) {
    if (Date.now() - startedAt > maxMs) {
      throw new Error("Veo: timed out waiting for the video (try 720p or the Fast model)");
    }
    await new Promise((r) => setTimeout(r, 10_000));
    const poll = await fetch(`${BASE}/${opName}`, { headers: { "x-goog-api-key": key } });
    if (!poll.ok) {
      // Transient poll hiccups shouldn't kill a job that's still running.
      if (poll.status >= 500 || poll.status === 429) continue;
      throw new Error(`Veo poll ${poll.status}: ${(await poll.text()).slice(0, 200)}`);
    }
    const data = (await poll.json()) as {
      done?: boolean;
      error?: { message?: string };
      response?: { generateVideoResponse?: { generatedSamples?: { video?: { uri?: string } }[] } };
    };
    if (data.error) throw new Error(`Veo failed: ${data.error.message || "unknown error"}`);
    if (data.done) {
      videoUri = data.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri;
      break;
    }
  }
  if (!videoUri) throw new Error("Veo finished but returned no video URI");

  // 3) Download the mp4. The URI is auth-gated, so send the API key header
  // (fetch follows the redirect to the signed file URL).
  const dl = await fetchWithRetry(videoUri, { headers: { "x-goog-api-key": key } });
  if (!dl.ok) throw new Error(`Veo download ${dl.status}`);
  return Buffer.from(await dl.arrayBuffer());
}
