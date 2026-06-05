// Shared asset query used by both the /assets page (server component) and the
// /api/assets route (consumed by the canvas drawer). Keeps classification,
// dedupe and brand-kit merging in one place.
import { prisma } from "@/lib/prisma";

export type AssetItem = {
  id: string;
  cdnUrl: string;
  kind: string;
  mimeType: string | null;
  sizeBytes: number | null;
  width: number | null;
  height: number | null;
  durationSec: number | null;
  source: string;
  model: string | null;
  prompt: string | null;
  createdAt: string;
  projectName: string | null;
  brandName: string | null;
};
export type FilterOption = { value: string; label: string };

export type AssetFilters = {
  project?: string;
  brand?: string;
  kind?: string;
  source?: string;
  sort?: string;
  q?: string;
  limit?: number;
};

// Re-derive the real kind from the URL — the stored `kind` column is
// unreliable for older rows (images saved as "text" by an old bug).
export function kindFromUrl(url: string, stored: string): string {
  const u = (url ?? "").split("?")[0].toLowerCase();
  if (/\.(mp4|webm|mov|m4v)$/.test(u)) return "video";
  if (/\.(mp3|wav|m4a|ogg|aac|flac)$/.test(u)) return "audio";
  if (/\.(jpg|jpeg|png|webp|gif|avif)$/.test(u)) return "image";
  if (stored === "video" || stored === "audio" || stored === "image") return stored;
  return (url ?? "").startsWith("http") ? "image" : "text";
}

type RawAsset = {
  id: string;
  cdnUrl: string;
  kind: string;
  mimeType: string | null;
  sizeBytes: bigint | null;
  width: number | null;
  height: number | null;
  durationSec: number | null;
  source: string;
  model: string | null;
  prompt: string | null;
  createdAt: Date;
  project: { id: string; name: string } | null;
  brand: { id: string; name: string; slug: string } | null;
};

export async function queryAssets(f: AssetFilters): Promise<{
  assets: AssetItem[];
  projects: FilterOption[];
  brands: FilterOption[];
}> {
  const limit = f.limit ?? 240;
  const where: {
    projectId?: string;
    brandId?: string;
    source?: string;
    OR?: { prompt?: { contains: string; mode: "insensitive" }; model?: { contains: string; mode: "insensitive" } }[];
  } = {};
  if (f.project) where.projectId = f.project;
  if (f.brand) where.brandId = f.brand;
  if (f.source) where.source = f.source;
  if (f.q) {
    where.OR = [
      { prompt: { contains: f.q, mode: "insensitive" } },
      { model: { contains: f.q, mode: "insensitive" } },
    ];
  }

  const FETCH = 1000;
  const [assetsRaw, projects, brands] = await Promise.all([
    prisma.asset.findMany({
      where,
      orderBy: { createdAt: f.sort === "oldest" ? "asc" : "desc" },
      take: FETCH,
      include: {
        project: { select: { id: true, name: true } },
        brand: { select: { id: true, name: true, slug: true } },
      },
    }),
    prisma.project.findMany({ where: { archivedAt: null }, orderBy: { updatedAt: "desc" }, select: { id: true, name: true } }),
    prisma.brand.findMany({ where: { archivedAt: null }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
  ]);

  const seenUrls = new Set<string>();
  const deduped: AssetItem[] = [];
  for (const a of assetsRaw as RawAsset[]) {
    if (!a.cdnUrl || seenUrls.has(a.cdnUrl)) continue;
    seenUrls.add(a.cdnUrl);
    deduped.push({
      id: a.id,
      cdnUrl: a.cdnUrl,
      kind: kindFromUrl(a.cdnUrl, a.kind),
      mimeType: a.mimeType ?? null,
      sizeBytes: a.sizeBytes != null ? Number(a.sizeBytes) : null,
      width: a.width ?? null,
      height: a.height ?? null,
      durationSec: a.durationSec ?? null,
      source: a.source,
      model: a.model ?? null,
      prompt: a.prompt ?? null,
      createdAt: a.createdAt.toISOString(),
      projectName: a.project?.name ?? null,
      brandName: a.brand?.name ?? null,
    });
  }
  const filteredByKind = f.kind ? deduped.filter((a) => a.kind === f.kind) : deduped;

  // Brand assets (brand_assets — the single source). Surfaced under the
  // "brand_kit" source in the drawer so they're pickable in workflows.
  let brandKit: AssetItem[] = [];
  const wantBrandKit = !f.source || f.source === "brand_kit";
  const wantImageKind = !f.kind || f.kind === "image";
  if (wantBrandKit && wantImageKind && !f.project && !f.q) {
    const rows = (await prisma.brandAsset.findMany({
      where: { kind: "image", ...(f.brand ? { brandId: f.brand } : {}) },
      orderBy: { createdAt: "desc" },
      select: { id: true, url: true, category: true, brand: { select: { id: true, name: true } } },
    })) as { id: string; url: string; category: string; brand: { id: string; name: string } | null }[];
    for (const r of rows) {
      if (!r.url.startsWith("http") || seenUrls.has(r.url)) continue;
      seenUrls.add(r.url);
      brandKit.push({
        id: `ba-${r.id}`,
        cdnUrl: r.url,
        kind: "image",
        mimeType: null,
        sizeBytes: null,
        width: null,
        height: null,
        durationSec: null,
        source: "brand_kit",
        model: null,
        prompt: null,
        createdAt: new Date(0).toISOString(),
        projectName: null,
        brandName: r.brand?.name ?? null,
      });
    }
  }

  const combined = f.source === "brand_kit" ? brandKit : [...filteredByKind, ...brandKit];
  return {
    assets: combined.slice(0, limit),
    projects: (projects as { id: string; name: string }[]).map((p) => ({ value: p.id, label: p.name })),
    brands: (brands as { id: string; name: string }[]).map((b) => ({ value: b.id, label: b.name })),
  };
}
