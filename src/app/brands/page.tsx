// src/app/brands/page.tsx
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import TopNav from "@/components/TopNav";
import CreateBrandButton from "@/components/CreateBrandButton";
import BrandCard, { type BrandCardData } from "@/components/BrandCard";

export default async function BrandsPage() {
  const user = await requireUser();

  const brands = await prisma.brand.findMany({
    where: { archivedAt: null },
    orderBy: { name: "asc" },
    include: { _count: { select: { projects: true } } },
  });

  return (
    <div className="grain min-h-screen">
      <TopNav
        activeNav="brands"
        crumbs={[
          { label: "Dashboard", href: "/dashboard" },
          { label: "Brands" },
        ]}
      />

      <main className="max-w-7xl mx-auto px-6 lg:px-12 py-12">
        <div className="flex items-end justify-between mb-10">
          <div>
            <div className="font-mono text-xs tracking-[0.2em] uppercase text-brand mb-3">
              ▶ All brands
            </div>
            <h1 className="font-display text-5xl leading-tight">Brands</h1>
            <p className="text-fg-muted text-sm mt-2">
              {brands.length === 0
                ? "No brands yet."
                : `${brands.length} brand${brands.length === 1 ? "" : "s"} · each one is a mobile app or product with its own projects, workflows and brand kit.`}
            </p>
          </div>
          {brands.length > 0 && <CreateBrandButton />}
        </div>

        {brands.length === 0 ? (
          <div className="bg-bg border border-dashed border-border-strong rounded-sm py-20 px-6 text-center">
            <div className="font-mono text-[10px] tracking-[0.2em] uppercase text-fg-muted mb-4">
              Empty state
            </div>
            <h3 className="font-display text-4xl mb-3">Set up your first brand.</h3>
            <p className="text-fg-muted text-sm mb-8 max-w-md mx-auto leading-relaxed">
              Brands are mobile apps you create ads for. Examples: Cleaner Pro, Wonderly.
              Each brand gets its own brand kit, projects, and assets.
            </p>
            <CreateBrandButton variant="primary" />
          </div>
        ) : (
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {brands.map((b: BrandCardData) => (
              <BrandCard key={b.id} brand={b} />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
