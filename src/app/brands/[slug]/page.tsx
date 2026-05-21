// src/app/brands/[slug]/page.tsx
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import TopNav from "@/components/TopNav";
import BrandActions from "@/components/BrandActions";
import CreateProjectButton from "@/components/CreateProjectButton";
import ProjectCard, { type ProjectCardData } from "@/components/ProjectCard";
import { getColor } from "@/lib/colors";
import { shortDate } from "@/lib/format";

export default async function BrandDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const user = await requireUser();

  const brand = await prisma.brand.findUnique({
    where: { slug },
    include: {
      creator: { select: { email: true } },
      _count: { select: { projects: true } },
    },
  });

  if (!brand) notFound();

  const projects = await prisma.project.findMany({
    where: { brandId: brand.id, archivedAt: null },
    orderBy: { updatedAt: "desc" },
    include: { _count: { select: { workflows: true } } },
  });

  const color = getColor(brand.color);

  return (
    <div className="grain min-h-screen">
      <TopNav
        activeNav="brands"
        crumbs={[
          { label: "Dashboard", href: "/dashboard" },
          { label: "Brands", href: "/brands" },
          { label: brand.name },
        ]}
      />

      <main className="max-w-7xl mx-auto px-6 lg:px-12 py-12">
        <div className="grid lg:grid-cols-[2fr,1fr] gap-8 mb-12">
          <div>
            <div className="flex items-center gap-3 mb-4">
              <div
                className={`w-12 h-12 rounded-sm ${color.bg} border ${color.border} flex items-center justify-center`}
              >
                <div className={`w-3 h-3 rounded-full ${color.dot}`} />
              </div>
              <div className="font-mono text-xs tracking-[0.2em] uppercase text-fg-muted">
                Brand · {brand.slug}
              </div>
            </div>
            <h1 className="font-display text-5xl md:text-6xl leading-tight mb-3">
              {brand.name}
            </h1>
            {brand.description ? (
              <p className="text-fg text-lg leading-relaxed max-w-2xl">
                {brand.description}
              </p>
            ) : (
              <p className="text-fg-subtle italic">No description.</p>
            )}
          </div>

          <div className="lg:pl-8 lg:border-l border-border flex flex-col">
            <div className="font-mono text-[10px] tracking-[0.2em] uppercase text-fg-muted mb-4">
              Brand record
            </div>
            <dl className="space-y-3 text-sm">
              <div className="flex justify-between gap-4 pb-3 border-b border-border">
                <dt className="text-fg-muted">Projects</dt>
                <dd className="font-mono tabular">{brand._count.projects}</dd>
              </div>
              <div className="flex justify-between gap-4 pb-3 border-b border-border">
                <dt className="text-fg-muted">Created</dt>
                <dd className="font-mono text-xs">{shortDate(brand.createdAt)}</dd>
              </div>
              <div className="flex justify-between gap-4 pb-3 border-b border-border">
                <dt className="text-fg-muted">Created by</dt>
                <dd className="font-mono text-xs truncate max-w-[200px]">
                  {brand.creator.email}
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-fg-muted">Updated</dt>
                <dd className="font-mono text-xs">{shortDate(brand.updatedAt)}</dd>
              </div>
            </dl>
            <div className="mt-auto pt-6">
              <BrandActions
                brand={{
                  id: brand.id,
                  name: brand.name,
                  description: brand.description,
                }}
                variant="inline"
              />
            </div>
          </div>
        </div>

        <section>
          <div className="flex items-end justify-between mb-6">
            <div>
              <div className="font-mono text-[10px] tracking-[0.2em] uppercase text-fg-muted mb-1">
                {projects.length} project{projects.length === 1 ? "" : "s"} in this brand
              </div>
              <h2 className="font-display text-3xl">Projects</h2>
            </div>
            {projects.length > 0 && (
              <CreateProjectButton variant="ghost" brandId={brand.id} />
            )}
          </div>

          {projects.length === 0 ? (
            <div className="bg-bg border border-dashed border-border-strong rounded-sm py-16 px-6 text-center">
              <div className="font-mono text-[10px] tracking-[0.2em] uppercase text-fg-muted mb-4">
                No projects yet
              </div>
              <h3 className="font-display text-3xl mb-3">Start working on {brand.name}.</h3>
              <p className="text-fg-muted text-sm mb-6 max-w-md mx-auto leading-relaxed">
                Create a project to organise workflows for this brand.
              </p>
              <CreateProjectButton variant="primary" brandId={brand.id} />
            </div>
          ) : (
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {projects.map((p: ProjectCardData) => (
                <ProjectCard key={p.id} project={p} />
              ))}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
