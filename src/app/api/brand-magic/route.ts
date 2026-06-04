// POST /api/brand-magic — one-shot brand autofill pipeline:
//   1. Find the App Store listing (iTunes Search by name, or the saved URL).
//   2. Pull description + screenshots + icon from iTunes.
//   3. Find the Google Play URL via web research.
//   4. Deep web research (Gemini + Google Search): voice, audience,
//      competitors, keywords, avoid, themes, colors.
//   5. Structure everything into brand-kit fields — ALWAYS in English.
//   6. Fill the kit (pitch generated; empty fields filled; screenshots merged;
//      icon + store URLs set). Returns a step-by-step summary + sources.
import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { callAgent } from "@/lib/agent/router";
import { revalidatePath } from "next/cache";
import { scrapeAppStoreScreenshots } from "@/lib/appstore";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const ENGLISH_SYSTEM = `You are a senior brand strategist and market researcher.
You investigate apps and brands and distill them into a precise, production-ready brand kit
used to brief AI models that generate marketing creative.

CRITICAL RULES:
- ALWAYS write every piece of output in ENGLISH, regardless of the language of the input,
  the prompt, the app's store locale, or the source material. Never output Russian or any
  other language in field values.
- Be concrete and factual. Prefer specifics over generic marketing fluff.
- When unsure, infer sensibly from the product category rather than leaving fields empty.`;

type ITunesApp = {
  trackId?: number;
  trackName?: string;
  trackViewUrl?: string;
  description?: string;
  screenshotUrls?: string[];
  ipadScreenshotUrls?: string[];
  artworkUrl512?: string;
  artworkUrl100?: string;
  sellerName?: string;
  primaryGenreName?: string;
};

async function itunesLookupById(id: string, country: string): Promise<ITunesApp | null> {
  const r = await fetch(`https://itunes.apple.com/lookup?id=${id}&country=${country}`, { cache: "no-store" });
  if (!r.ok) return null;
  const j = (await r.json()) as { results?: ITunesApp[] };
  return j.results?.[0] ?? null;
}

async function itunesSearchByName(name: string): Promise<ITunesApp | null> {
  const r = await fetch(
    `https://itunes.apple.com/search?term=${encodeURIComponent(name)}&entity=software&limit=1&country=us`,
    { cache: "no-store" },
  );
  if (!r.ok) return null;
  const j = (await r.json()) as { results?: ITunesApp[] };
  return j.results?.[0] ?? null;
}

export async function POST(req: Request): Promise<NextResponse> {
  await requireUser();
  let body: { brandId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Bad request" }, { status: 400 });
  }
  const brandId = body.brandId;
  if (!brandId) return NextResponse.json({ ok: false, error: "brandId required" }, { status: 400 });

  const brand = await prisma.brand.findUnique({ where: { id: brandId } });
  const kit = await prisma.brandKit.findUnique({ where: { brandId } });
  if (!brand) return NextResponse.json({ ok: false, error: "Brand not found" }, { status: 404 });

  const seed = [brand.name, kit?.productPitch].filter(Boolean).join(" ").trim();
  if (!seed && !kit?.appStoreUrl) {
    return NextResponse.json(
      { ok: false, error: "Добавь хотя бы название бренда или ссылку App Store." },
      { status: 400 },
    );
  }

  const steps: string[] = [];
  try {
    // ── 1-2. App Store: by saved URL id, else search by name ──────────────
    let app: ITunesApp | null = null;
    let appStoreUrl = kit?.appStoreUrl || "";
    const idMatch = appStoreUrl.match(/id(\d+)/);
    if (idMatch) {
      const country = (appStoreUrl.match(/apps\.apple\.com\/([a-z]{2})\//i)?.[1] || "us").toLowerCase();
      app = await itunesLookupById(idMatch[1], country);
      steps.push("App Store: по сохранённой ссылке");
    } else if (brand.name) {
      app = await itunesSearchByName(brand.name);
      if (app?.trackViewUrl) appStoreUrl = app.trackViewUrl;
      steps.push(app ? `App Store: найдено по названию (${app.trackName})` : "App Store: не найдено по названию");
    }

    // Prefer iPhone screenshots; fall back to iPad only if there are none.
    const iphoneShots = ((app?.screenshotUrls as string[]) || []).filter((u) => typeof u === "string" && u.startsWith("http"));
    const ipadShots = ((app?.ipadScreenshotUrls as string[]) || []).filter((u) => typeof u === "string" && u.startsWith("http"));
    const screenshotUrls = iphoneShots.length ? iphoneShots : ipadShots;

    // Fallback: if the API gave no screenshots, scrape the exact store page
    // (the app the user linked) — never a different app from a name search.
    if (screenshotUrls.length === 0 && appStoreUrl) {
      const scraped = await scrapeAppStoreScreenshots(appStoreUrl);
      if (scraped.length) {
        screenshotUrls.push(...scraped);
        steps.push(`Скриншоты: со страницы стора (${scraped.length})`);
      } else {
        steps.push("Скриншоты: не удалось получить со страницы");
      }
    }
    const icon = app?.artworkUrl512 || app?.artworkUrl100 || null;
    const storeDescription = app?.description || "";
    const developer = app?.sellerName || "";
    const genre = app?.primaryGenreName || "";

    // ── 3. Google Play URL via quick research ─────────────────────────────
    let googlePlayUrl = kit?.googlePlayUrl || "";
    if (!googlePlayUrl && brand.name) {
      try {
        const gp = await callAgent({
          task: "research",
          webSearch: true,
          system: ENGLISH_SYSTEM,
          user: `Find the official Google Play Store URL for the app "${brand.name}"${developer ? ` by ${developer}` : ""}.
Reply with ONLY the URL (https://play.google.com/store/apps/details?id=...) or the single word NONE.`,
        });
        const m = gp.text.match(/https:\/\/play\.google\.com\/store\/apps\/details\?id=[\w.]+/);
        if (m) {
          googlePlayUrl = m[0];
          steps.push("Google Play: найдено");
        }
      } catch {
        /* ignore */
      }
    }

    // ── 4. Deep research (web) ────────────────────────────────────────────
    const subject = [brand.name, storeDescription || kit?.productPitch, appStoreUrl].filter(Boolean).join(" — ");
    const research = await callAgent({
      task: "research",
      webSearch: true,
      system: ENGLISH_SYSTEM,
      user: `Research this app/brand thoroughly using live web search. Write findings in English.
Object: ${subject}
${developer ? `Developer: ${developer}` : ""}
${genre ? `Category: ${genre}` : ""}

Cover: positioning & one-line pitch; tone of voice; target audience; 3-6 real competitors;
brand keywords/phrases to use; words/themes to avoid; likely brand colors (hex if known);
sensitive themes to never touch; official website and social profile URLs (Instagram, TikTok,
YouTube, X/Twitter). Base it on real search results.`,
    });
    steps.push("Ресёрч в сети: готово");

    // ── 5. Structure → English JSON ───────────────────────────────────────
    const structured = await callAgent({
      task: "generate",
      json: true,
      system: ENGLISH_SYSTEM + "\nReturn STRICT valid JSON only. No markdown, no commentary. All values in English.\nNEVER fabricate or guess URLs (website or social links). Only output a URL if it explicitly appeared in the research text/sources; otherwise use an empty string. A wrong link is worse than none.",
      user: `From the research below, produce JSON exactly in this schema (all values in English):
{
  "productPitch": "1-2 sentence pitch: what the app does and for whom",
  "voice": "tone of voice in 1-2 sentences",
  "audience": "target audience",
  "lexiconAllow": "comma-separated on-brand keywords/phrases",
  "lexiconAvoid": "comma-separated words/phrases to avoid",
  "bannedThemes": "comma-separated sensitive themes to never mention",
  "colors": "space-separated hex codes if identifiable, else empty string",
  "fonts": "headline and body font names if identifiable (e.g. 'Inter (body), Source Serif Pro (headline)'), else empty string",
  "website": "official website URL — ONLY if it appeared in the research/sources, else empty string",
  "instagram": "full Instagram profile URL — ONLY if a real, verified handle appeared in the research/sources, else empty string",
  "tiktok": "full TikTok profile URL — ONLY if verified in the research/sources, else empty string",
  "youtube": "YouTube channel URL — ONLY if verified in the research/sources, else empty string",
  "x": "X/Twitter profile URL — ONLY if verified in the research/sources, else empty string",
  "competitors": ["competitor names"],
  "summary": "2-3 sentence brand summary"
}

App Store description (for grounding):
${storeDescription.slice(0, 1500)}

Research:
${research.text}`,
    });

    let p: {
      productPitch?: string;
      voice?: string;
      audience?: string;
      lexiconAllow?: string;
      lexiconAvoid?: string;
      bannedThemes?: string;
      colors?: string;
      fonts?: string;
      website?: string;
      instagram?: string;
      tiktok?: string;
      youtube?: string;
      x?: string;
      competitors?: string[];
      summary?: string;
    } = {};
    try {
      p = JSON.parse(structured.text);
    } catch {
      p = {};
    }

    // ── 6. Fill the kit ───────────────────────────────────────────────────
    // Store screenshots now go into brand_assets (category "store"), the
    // single source of truth — not a BrandKit field.
    const data: Record<string, string | null> = {};
    if (appStoreUrl) data.appStoreUrl = appStoreUrl;
    if (googlePlayUrl) data.googlePlayUrl = googlePlayUrl;
    // Pitch: generated English pitch replaces a command-like/empty pitch.
    if (p.productPitch) data.productPitch = p.productPitch;
    // The rest: fill only if empty (don't clobber manual edits).
    if (p.voice && !kit?.voice) data.voice = p.voice;
    if (p.lexiconAllow && !kit?.lexiconAllow) data.lexiconAllow = p.lexiconAllow;
    if (p.lexiconAvoid && !kit?.lexiconAvoid) data.lexiconAvoid = p.lexiconAvoid;
    if (p.bannedThemes && !kit?.bannedThemes) data.bannedThemes = p.bannedThemes;
    if (p.colors && !kit?.colors) data.colors = p.colors;
    if (p.fonts && !kit?.fonts) data.fonts = p.fonts;
    if (p.website && !kit?.website) data.website = p.website;
    if (p.instagram && !kit?.socialInstagram) data.socialInstagram = p.instagram;
    if (p.tiktok && !kit?.socialTiktok) data.socialTiktok = p.tiktok;
    if (p.youtube && !kit?.socialYoutube) data.socialYoutube = p.youtube;
    if (p.x && !kit?.socialX) data.socialX = p.x;

    await prisma.brandKit.upsert({
      where: { brandId },
      create: { brandId, ...data },
      update: data,
    });

    // Store screenshots → brand_assets (category "store"), deduped against
    // existing store rows. This is now the single home for all assets.
    let addedScreenshots = 0;
    if (screenshotUrls.length) {
      const existing = await prisma.brandAsset.findMany({
        where: { brandId, category: "store" },
        select: { url: true },
      });
      const have = new Set(existing.map((a: { url: string }) => a.url));
      const toAdd = [...new Set(screenshotUrls)].filter((u) => !have.has(u));
      if (toAdd.length) {
        await prisma.brandAsset.createMany({
          data: toAdd.map((url) => ({ brandId, url, kind: "image", category: "store", label: "Store screenshot" })),
        });
        addedScreenshots = toAdd.length;
      }
    }

    // App icon → brand_assets (category "logo") + brand.iconUrl for the preview.
    if (icon) {
      await prisma.brand.update({ where: { id: brandId }, data: { iconUrl: icon } }).catch(() => {});
      const haveIcon = await prisma.brandAsset.findFirst({ where: { brandId, url: icon } });
      if (!haveIcon) {
        await prisma.brandAsset
          .create({ data: { brandId, url: icon, kind: "image", category: "logo", label: "App icon" } })
          .catch(() => {});
      }
    }
    try {
      revalidatePath(`/brands/${brand.slug}/brand-kit`);
    } catch {
      /* ignore */
    }

    return NextResponse.json({
      ok: true,
      steps,
      filled: Object.keys(data),
      found: {
        appStoreUrl,
        googlePlayUrl,
        screenshots: screenshotUrls.length,
        addedScreenshots,
        icon: !!icon,
        audience: p.audience ?? "",
        competitors: p.competitors ?? [],
        summary: p.summary ?? "",
      },
      sources: research.sources ?? [],
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Magic autofill failed";
    console.error("[api/brand-magic] failed:", msg);
    return NextResponse.json({ ok: false, error: msg, steps }, { status: 500 });
  }
}
