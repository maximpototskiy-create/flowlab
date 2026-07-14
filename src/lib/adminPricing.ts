// Estimated unit prices for DIRECT generations (corporate Google/OpenAI
// keys). Their recorded costUsd is 0 in our DB (billed outside fal), so the
// admin dashboard uses these estimates to keep the potential bill visible.
//
// VERIFIED against vendor pricing docs (July 2026):
// - Gemini image output is token-billed at $60/1M tokens
//   (ai.google.dev/gemini-api/docs/pricing):
//     Gemini 3.1 Flash Image: 1K image = 1120 tokens = ~$0.067
//       (0.5K ~$0.045 / 2K ~$0.101 / 4K ~$0.151)
//     Gemini 3 Pro Image: ~$0.134 at 1K/2K, ~$0.24 at 4K
// - Imagen 4: fast $0.02 / standard $0.04 / ultra $0.06 per image
//   (deprecated by Google - shutdown Aug 17, 2026)
// - GPT Image 2 (OpenAI, token-based; 1024x1024): low ~$0.006 /
//   medium ~$0.053 / high ~$0.211; portrait-landscape slightly cheaper.
//   The app default is MEDIUM, so the estimate below uses ~$0.055 -
//   note that "high" runs cost ~4x more than this estimate.
export const DIRECT_PRICE_EST: Record<string, number> = {
  "google/gemini-3.1-flash-image": 0.067,
  "google/gemini-3-pro-image-preview": 0.134,
  "google/imagen-4.0-ultra-generate-001": 0.06,
  "google/imagen-4.0-generate-001": 0.04,
  "openai/gpt-image-2": 0.055,
  "openai/gpt-image-1": 0.042,
};

export function directUnitEst(model: string): number {
  return DIRECT_PRICE_EST[model] ?? 0.05;
}
