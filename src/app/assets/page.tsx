// src/app/assets/page.tsx — Asset Library page. Thin wrapper around the
// shared queryAssets() helper (also used by /api/assets for the canvas drawer).
import { requireUser } from "@/lib/auth";
import AssetsShell from "@/components/AssetsShell";
import AssetGallery from "@/components/assets/AssetGallery";
import { queryAssets } from "@/lib/assetsQuery";

export const dynamic = "force-dynamic";

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
  const sort = pick("sort");

  const { assets, projects, brands } = await queryAssets({ project, brand, kind, source, q, sort });

  return (
    <AssetsShell>
      <p className="text-fg-muted text-sm mb-6">
        {assets.length === 0
          ? "No assets match these filters yet."
          : `${assets.length} asset${assets.length === 1 ? "" : "s"}.`}
      </p>
      <AssetGallery
        assets={assets}
        projects={projects}
        brands={brands}
        active={{ project, brand, kind, source, q, sort }}
      />
    </AssetsShell>
  );
}
