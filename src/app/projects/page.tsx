// src/app/projects/page.tsx
import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import TopNav from "@/components/TopNav";
import ProjectCard, { type ProjectCardData } from "@/components/ProjectCard";

export default async function ProjectsPage() {
  const user = await requireUser();

  const [projects, brandsCount] = await Promise.all([
    prisma.project.findMany({
      where: { archivedAt: null },
      orderBy: { updatedAt: "desc" },
      include: {
        _count: { select: { workflows: true } },
        brand: { select: { name: true, slug: true } },
      },
    }),
    prisma.brand.count({ where: { archivedAt: null } }),
  ]);

  return (
    <div className="grain min-h-screen">
      <TopNav
        activeNav="projects"
        crumbs={[{ label: "Dashboard", href: "/dashboard" }, { label: "Projects" }]}
      />

      <main className="max-w-7xl mx-auto px-6 lg:px-12 py-12">
        <div className="flex items-end justify-between mb-10">
          <div>
            <div className="font-mono text-xs tracking-[0.2em] uppercase text-brand mb-3">
              ▶ All projects
            </div>
            <h1 className="font-display text-5xl leading-tight">Projects</h1>
            <p className="text-fg-muted text-sm mt-2">
              {projects.length === 0
                ? "No projects yet."
                : `${projects.length} project${projects.length === 1 ? "" : "s"} across all brands.`}
            </p>
          </div>
          <Link
            href="/brands"
            className="font-mono text-[11px] tracking-[0.15em] uppercase text-fg-muted hover:text-fg border border-border-strong hover:border-border-strong px-4 py-2 rounded-sm transition"
          >
            Browse brands →
          </Link>
        </div>

        {projects.length === 0 ? (
          <div className="bg-bg border border-dashed border-border-strong rounded-sm py-20 px-6 text-center">
            <div className="font-mono text-[10px] tracking-[0.2em] uppercase text-fg-muted mb-4">
              Empty state
            </div>
            <h3 className="font-display text-4xl mb-3">
              {brandsCount === 0 ? "No brands yet." : "No projects yet."}
            </h3>
            <p className="text-fg-muted text-sm mb-8 max-w-md mx-auto leading-relaxed">
              {brandsCount === 0
                ? "Projects live inside brands. Create your first brand to get started."
                : "Open a brand and create a project there."}
            </p>
            <Link
              href="/brands"
              className="inline-block bg-brand text-black font-mono text-xs tracking-[0.15em] uppercase py-3 px-5 rounded-sm hover:bg-emerald-400 transition"
            >
              Go to brands →
            </Link>
          </div>
        ) : (
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {projects.map((p: ProjectCardData) => (
              <ProjectCard key={p.id} project={p} />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
