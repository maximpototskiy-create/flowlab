// src/app/dashboard/page.tsx
import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import TopNav from "@/components/TopNav";
import CreateBrandButton from "@/components/CreateBrandButton";
import ProjectCard, { type ProjectCardData } from "@/components/ProjectCard";
import BrandCard, { type BrandCardData } from "@/components/BrandCard";
import { relativeTime } from "@/lib/format";

export default async function DashboardPage() {
  const user = await requireUser();

  // Fetch stats and recent items in parallel
  const [
    brandsCount,
    projectsCount,
    workflowsCount,
    teamMembersCount,
    recentBrands,
    recentProjects,
    recentWorkflows,
  ] = await Promise.all([
    prisma.brand.count({ where: { archivedAt: null } }),
    prisma.project.count({ where: { archivedAt: null } }),
    prisma.workflow.count(),
    prisma.user.count(),
    prisma.brand.findMany({
      where: { archivedAt: null },
      orderBy: { updatedAt: "desc" },
      take: 4,
      include: { _count: { select: { projects: true } } },
    }),
    prisma.project.findMany({
      where: { archivedAt: null },
      orderBy: { updatedAt: "desc" },
      take: 4,
      include: { _count: { select: { workflows: true } } },
    }),
    prisma.workflow.findMany({
      orderBy: { updatedAt: "desc" },
      take: 5,
      include: {
        project: { select: { id: true, name: true, color: true } },
        creator: { select: { email: true } },
      },
    }),
  ]);

  return (
    <div className="grain min-h-screen">
      <TopNav activeNav="dashboard" />

      <main className="max-w-7xl mx-auto px-6 lg:px-12 py-12 md:py-16">
        {/* Hero */}
        <div className="mb-12 md:mb-16 animate-fade-up">
          <div className="font-mono text-xs tracking-[0.2em] uppercase text-brand mb-6">
            ▶ Welcome back
          </div>
          <h1 className="font-display text-5xl md:text-6xl leading-[1.05] mb-4">
            Hello, <em className="text-brand">{user.email.split("@")[0]}</em>.
          </h1>
          <p className="text-fg-muted text-lg leading-relaxed max-w-2xl">
            {brandsCount === 0
              ? "Get started by creating your first brand."
              : `${workflowsCount} workflow${workflowsCount === 1 ? "" : "s"} across ${projectsCount} project${projectsCount === 1 ? "" : "s"} in ${brandsCount} brand${brandsCount === 1 ? "" : "s"}.`}
          </p>
        </div>

        {/* Stats strip */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-px bg-bg-subtle border border-border mb-12">
          <StatCell label="Brands" value={brandsCount} />
          <StatCell label="Projects" value={projectsCount} />
          <StatCell label="Workflows" value={workflowsCount} />
          <StatCell label="Team members" value={teamMembersCount} />
          <StatCell label="Your role" value={user.role.toUpperCase()} isText />
        </div>

        {/* Recent Brands */}
        {recentBrands.length > 0 && (
          <section className="mb-16">
            <div className="flex items-end justify-between mb-6">
              <div>
                <div className="font-mono text-[10px] tracking-[0.2em] uppercase text-fg-muted mb-1">
                  Your portfolio
                </div>
                <h2 className="font-display text-3xl">Brands</h2>
              </div>
              <div className="flex gap-3 items-center">
                <Link
                  href="/brands"
                  className="font-mono text-[11px] tracking-[0.15em] uppercase text-fg-muted hover:text-fg transition"
                >
                  View all →
                </Link>
                <CreateBrandButton variant="ghost" />
              </div>
            </div>
            <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
              {recentBrands.map((b: BrandCardData) => (
                <BrandCard key={b.id} brand={b} />
              ))}
            </div>
          </section>
        )}

        {/* Recent Projects */}
        <section className="mb-16">
          <div className="flex items-end justify-between mb-6">
            <div>
              <div className="font-mono text-[10px] tracking-[0.2em] uppercase text-fg-muted mb-1">
                Recently updated
              </div>
              <h2 className="font-display text-3xl">Projects</h2>
            </div>
            <div className="flex gap-3 items-center">
              <Link
                href="/projects"
                className="font-mono text-[11px] tracking-[0.15em] uppercase text-fg-muted hover:text-fg transition"
              >
                View all →
              </Link>
            </div>
          </div>

          {recentProjects.length === 0 ? (
            <EmptyProjects hasBrands={brandsCount > 0} />
          ) : (
            <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
              {recentProjects.map((p: ProjectCardData) => (
                <ProjectCard key={p.id} project={p} />
              ))}
            </div>
          )}
        </section>

        {/* Recent Workflows */}
        {recentWorkflows.length > 0 && (
          <section>
            <div className="mb-6">
              <div className="font-mono text-[10px] tracking-[0.2em] uppercase text-fg-muted mb-1">
                Recent activity
              </div>
              <h2 className="font-display text-3xl">Workflows</h2>
            </div>

            <div className="bg-bg border border-border rounded-sm overflow-hidden">
              {recentWorkflows.map((wf: {
                id: string;
                projectId: string;
                name: string;
                updatedAt: Date;
                project: { id: string; name: string; color: string };
                creator: { email: string };
              }) => (
                <Link
                  key={wf.id}
                  href={`/projects/${wf.projectId}/workflows/${wf.id}`}
                  className="group flex items-center gap-4 px-5 py-4 border-b border-border last:border-b-0 hover:bg-bg-hover/50 transition"
                >
                  <div className="font-display text-lg leading-tight flex-1 truncate group-hover:text-brand transition">
                    {wf.name}
                  </div>
                  <div className="hidden md:block font-mono text-[10px] tracking-wider uppercase text-fg-subtle truncate">
                    in {wf.project.name}
                  </div>
                  <div className="font-mono text-[10px] tracking-wider uppercase text-fg-subtle whitespace-nowrap">
                    {relativeTime(wf.updatedAt)}
                  </div>
                </Link>
              ))}
            </div>
          </section>
        )}
      </main>

      <footer className="border-t border-border mt-24">
        <div className="max-w-7xl mx-auto px-6 lg:px-12 py-6 flex justify-between items-center font-mono text-[10px] tracking-wider uppercase text-fg-subtle">
          <div>FlowLab v0.2 — Internal tool</div>
          <div>Part of Creative Lab</div>
        </div>
      </footer>
    </div>
  );
}

function StatCell({
  label,
  value,
  isText = false,
}: {
  label: string;
  value: string | number;
  isText?: boolean;
}) {
  return (
    <div className="bg-bg px-5 py-5">
      <div className="font-mono text-[10px] tracking-[0.2em] uppercase text-fg-muted mb-2">
        {label}
      </div>
      <div
        className={
          isText
            ? "font-mono text-sm tracking-wider text-fg"
            : "font-display text-4xl text-fg tabular"
        }
      >
        {value}
      </div>
    </div>
  );
}

function EmptyProjects({ hasBrands }: { hasBrands: boolean }) {
  if (!hasBrands) {
    return (
      <div className="bg-bg border border-dashed border-border-strong rounded-sm py-16 px-6 text-center">
        <div className="font-mono text-[10px] tracking-[0.2em] uppercase text-fg-muted mb-4">
          Get started
        </div>
        <h3 className="font-display text-3xl mb-2">First, create a brand.</h3>
        <p className="text-fg-muted text-sm mb-6 max-w-md mx-auto">
          Brands are your mobile apps. Each brand has its own projects, workflows, and brand kit.
        </p>
        <CreateBrandButton variant="primary" />
      </div>
    );
  }
  return (
    <div className="bg-bg border border-dashed border-border-strong rounded-sm py-16 px-6 text-center">
      <div className="font-mono text-[10px] tracking-[0.2em] uppercase text-fg-muted mb-4">
        Empty state
      </div>
      <h3 className="font-display text-3xl mb-2">No projects yet.</h3>
      <p className="text-fg-muted text-sm mb-6 max-w-md mx-auto">
        Open a brand and create a project there.
      </p>
      <Link
        href="/brands"
        className="inline-block bg-brand text-black font-mono text-xs tracking-[0.15em] uppercase py-3 px-5 rounded-sm hover:bg-emerald-400 transition"
      >
        Go to brands →
      </Link>
    </div>
  );
}
