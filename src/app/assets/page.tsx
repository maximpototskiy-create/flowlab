// src/app/assets/page.tsx — Asset Library page. Thin wrapper around the
// shared queryAssets() helper (also used by /api/assets for the canvas drawer).
import { requireUser } from "@/lib/auth";
import TopNav from "@/components/TopNav";
import AssetTabs from "@/components/AssetTabs";
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
            {assets.length === 0
              ? "No assets match these filters yet."
              : `${assets.length} asset${assets.length === 1 ? "" : "s"}.`}
          </p>
        </div>

        <AssetTabs />

        <AssetGallery
          assets={assets}
          projects={projects}
          brands={brands}
          active={{ project, brand, kind, source, q, sort }}
        />
      </main>
    </div>
  );
}
