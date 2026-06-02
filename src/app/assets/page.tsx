// src/app/assets/page.tsx
// Asset Library — browse every generated/uploaded asset, filterable by
// project / brand / type / source, searchable by prompt. Server component
// reads filters from the URL searchParams, queries Prisma, and hands plain
// (BigInt-free) objects to the client gallery.
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import TopNav from "@/components/TopNav";
import AssetGallery, { type AssetItem, type FilterOption } from "@/components/assets/AssetGallery";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 240;

export default async function AssetsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireUser();
  const sp = await searchParams;
  const pick = (k: string) => (Array.isArray(sp[k]) ? sp[k]?.[0] : sp[k]) as string | undefined;

  const project = pick("project");
  const brand = pick("brand");
  const kind = pick("kind");
  const source = pick("source");
  const q = pick("q")?.trim();

  const where: {
    projectId?: string;
    brandId?: string;
    kind?: string;
    source?: string;
    prompt?: { contains: string; mode: "insensitive" };
  } = {};
  if (project) where.projectId = project;
  if (brand) where.brandId = brand;
  if (kind) where.kind = kind;
  if (source) where.source = source;
  if (q) where.prompt = { contains: q, mode: "insensitive" };

  const [assetsRaw, projects, brands, total] = await Promise.all([
    prisma.asset.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: PAGE_SIZE,
      include: {
        project: { select: { id: true, name: true } },
        brand: { select: { id: true, name: true, slug: true } },
      },
    }),
    prisma.project.findMany({
      where: { archivedAt: null },
      orderBy: { updatedAt: "desc" },
      select: { id: true, name: true },
    }),
    prisma.brand.findMany({
      where: { archivedAt: null },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
    prisma.asset.count({ where }),
  ]);

  // Strip BigInt (sizeBytes, seed) → number/string so the data can cross into
  // the client component (BigInt isn't JSON-serializable).
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
  const assets: AssetItem[] = (assetsRaw as RawAsset[]).map((a) => ({
    id: a.id,
    cdnUrl: a.cdnUrl,
    kind: a.kind,
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
  }));

  const projectOpts: FilterOption[] = (projects as { id: string; name: string }[]).map((p) => ({ value: p.id, label: p.name }));
  const brandOpts: FilterOption[] = (brands as { id: string; name: string }[]).map((b) => ({ value: b.id, label: b.name }));

  return (
    <div className="grain min-h-screen">
      <TopNav
        activeNav="assets"
        crumbs={[{ label: "Dashboard", href: "/dashboard" }, { label: "Assets" }]}
      />
      <main className="max-w-7xl mx-auto px-6 lg:px-12 py-12">
        <div className="mb-8">
          <div className="font-mono text-xs tracking-[0.2em] uppercase text-brand mb-3">
            ▶ Asset library
          </div>
          <h1 className="font-display text-5xl leading-tight">Assets</h1>
          <p className="text-fg-muted text-sm mt-2">
            {total === 0
              ? "No assets match these filters yet."
              : `${total} asset${total === 1 ? "" : "s"}${
                  total > PAGE_SIZE ? ` — showing latest ${PAGE_SIZE}` : ""
                }.`}
          </p>
        </div>

        <AssetGallery
          assets={assets}
          projects={projectOpts}
          brands={brandOpts}
          active={{ project, brand, kind, source, q }}
        />
      </main>
    </div>
  );
}
