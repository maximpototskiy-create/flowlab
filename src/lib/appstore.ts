// App Store helpers. We pull screenshots by SCRAPING the actual store page
// HTML (not the iTunes lookup API), because for many apps the API returns an
// empty screenshotUrls while the page itself has them — and the page is the
// exact app the user linked, so we never grab a different app's shots.

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
  Accept: "text/html,application/xhtml+xml",
};

export function extractAppId(appStoreUrl: string): string | null {
  return appStoreUrl.match(/id(\d+)/)?.[1] ?? null;
}

export function extractCountry(appStoreUrl: string): string {
  return (appStoreUrl.match(/apps\.apple\.com\/([a-z]{2})\//i)?.[1] || "us").toLowerCase();
}

// Scrape screenshot image URLs from an App Store product page.
// Apple serves screenshots as mzstatic "thumb" URLs ending in /WIDTHxHEIGHTbb.EXT.
// We keep the largest size per unique image and drop square-ish images (icons).
export async function scrapeAppStoreScreenshots(appStoreUrl: string): Promise<string[]> {
  let html = "";
  try {
    const res = await fetch(appStoreUrl, { headers: BROWSER_HEADERS, cache: "no-store" });
    if (!res.ok) return [];
    html = await res.text();
  } catch {
    return [];
  }

  const re = /https:\/\/[a-z0-9-]+\.mzstatic\.com\/image\/thumb\/[^"'\\\s)]+?\/\d+x\d+bb\.(?:png|jpg|jpeg|webp)/gi;
  const matches = html.match(re) || [];

  // Keep the largest variant per unique base path.
  const best = new Map<string, { url: string; area: number; w: number; h: number }>();
  for (const u of matches) {
    const m = u.match(/\/(\d+)x(\d+)bb\.(?:png|jpg|jpeg|webp)$/i);
    if (!m) continue;
    const w = +m[1];
    const h = +m[2];
    const base = u.replace(/\/\d+x\d+bb\.(?:png|jpg|jpeg|webp)$/i, "");
    const area = w * h;
    const cur = best.get(base);
    if (!cur || area > cur.area) best.set(base, { url: u, area, w, h });
  }

  const candidates = [...best.values()].filter((v) => {
    const ratio = v.w / v.h;
    const big = Math.max(v.w, v.h) >= 300;
    const notSquare = ratio < 0.85 || ratio > 1.18;
    return big && notSquare;
  });

  // Prefer iPhone screenshots: tall, narrow portraits (ratio < ~0.62, e.g.
  // 1290x2796 ≈ 0.46). iPad portraits are wider (~0.75). If we have any
  // phone-shaped shots, return only those; otherwise fall back to whatever
  // portrait shots exist.
  const phone = candidates.filter((v) => v.w / v.h > 0 && v.w / v.h < 0.62);
  const chosen = phone.length ? phone : candidates;
  return chosen.map((v) => v.url);
}
