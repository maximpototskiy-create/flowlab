// Estimated unit prices for DIRECT generations (corporate Google/OpenAI
// keys). Their recorded costUsd is 0 in our DB (billed outside fal), so the
// admin dashboard uses these estimates to keep the potential bill visible.
// Update as vendor pricing changes.
export const DIRECT_PRICE_EST: Record<string, number> = {
  "google/gemini-3.1-flash-image": 0.04,
  "google/gemini-3-pro-image-preview": 0.15,
  "google/imagen-4.0-ultra-generate-001": 0.06,
  "google/imagen-4.0-generate-001": 0.04,
  "openai/gpt-image-2": 0.07,
  "openai/gpt-image-1": 0.05,
};

export function directUnitEst(model: string): number {
  return DIRECT_PRICE_EST[model] ?? 0.05;
}
