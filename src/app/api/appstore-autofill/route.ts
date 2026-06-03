// POST /api/appstore-autofill — looks up an App Store listing via the free
// iTunes API and fills the brand kit (pitch / screenshots / icon). Returns a
// summary of what was found so the UI can show real status.
import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<NextResponse> {
  await requireUser();
  let body: { brandId?: string; appStoreUrl?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Bad request" }, { status: 400 });
  }
  const brandId = body.brandId;
  const appStoreUrl = (body.appStoreUrl || "").trim();
  if (!brandId) return NextResponse.json({ ok: false, error: "brandId required" }, { status: 400 });
  if (!appStoreUrl) return NextResponse.json({ ok: false, error: "Вставь ссылку на App Store" }, { status: 400 });

  const m = appStoreUrl.match(/id(\d+)/);
  if (!m) return NextResponse.json({ ok: false, error: "В ссылке не найден id приложения" }, { status: 400 });
  const appId = m[1];
  const countryMatch = appStoreUrl.match(/apps\.apple\.com\/([a-z]{2})\//i);
  const country = countryMatch ? countryMatch[1].toLowerCase() : "us";

  try {
    const res = await fetch(`https://itunes.apple.com/lookup?id=${appId}&country=${country}`, { cache: "no-store" });
    if (!res.ok) return NextResponse.json({ ok: false, error: `iTunes ${res.status}` }, { status: 502 });
    const json = (await res.json()) as { resultCount?: number; results?: Array<Record<string, unknown>> };
    const app = json.results?.[0];
    if (!app) {
      return NextResponse.json({ ok: false, error: "Приложение не найдено в этой стране. Проверь ссылку." }, { status: 404 });
    }

    const screenshotUrls = [
      ...((app.screenshotUrls as string[]) || []),
      ...((app.ipadScreenshotUrls as string[]) || []),
    ].filter((u) => typeof u === "string" && u.startsWith("http"));
    const icon = (app.artworkUrl512 as string) || (app.artworkUrl100 as string) || null;
    const description = (app.description as string) || "";
    const trackName = (app.trackName as string) || "";

    const existing = await prisma.brandKit.findUnique({ where: { brandId } });
    const existingShots = (existing?.uiScreenshots || "").split("\n").map((s: string) => s.trim()).filter(Boolean);
    const mergedShots = [...new Set([...existingShots, ...screenshotUrls])];

    const data = {
      appStoreUrl,
      productPitch: existing?.productPitch || description.slice(0, 800) || null,
      uiScreenshots: mergedShots.join("\n") || null,
    };
    await prisma.brandKit.upsert({ where: { brandId }, create: { brandId, ...data }, update: data });

    const brand = await prisma.brand.findUnique({ where: { id: brandId } });
    if (icon && brand) {
      await prisma.brand.update({ where: { id: brandId }, data: { iconUrl: icon } }).catch(() => {});
    }

    return NextResponse.json({
      ok: true,
      found: {
        name: trackName,
        description: !!description,
        screenshots: screenshotUrls.length,
        addedScreenshots: mergedShots.length - existingShots.length,
        icon: !!icon,
        pitchFilled: !existing?.productPitch && !!description,
      },
    });
  } catch (err) {
    console.error("[api/appstore-autofill] failed:", err);
    return NextResponse.json({ ok: false, error: "Не удалось получить данные" }, { status: 500 });
  }
}
