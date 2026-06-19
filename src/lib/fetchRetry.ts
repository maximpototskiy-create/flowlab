// fetch wrapper that retries on 429 (rate limit) and 5xx with backoff,
// respecting a Retry-After header when present. Returns the final Response
// (the caller still checks res.ok). Used by the direct OpenAI/Google image
// clients, where bursts of parallel requests can hit provider rate limits.
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  maxRetries = 3,
): Promise<Response> {
  let attempt = 0;
  for (;;) {
    const res = await fetch(url, init);
    if (res.ok || attempt >= maxRetries) return res;
    // Only retry transient failures; surface 4xx (other than 429) immediately.
    if (res.status !== 429 && res.status < 500) return res;
    const retryAfter = Number(res.headers.get("retry-after"));
    const waitMs =
      Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, 20000)
        : Math.min(1500 * 2 ** attempt, 20000);
    await new Promise((r) => setTimeout(r, waitMs));
    attempt++;
  }
}
