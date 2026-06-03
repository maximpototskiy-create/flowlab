// src/app/projects/[id]/page.tsx
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import TopNav from "@/components/TopNav";
import CreateWorkflowButton from "@/components/CreateWorkflowButton";
import WorkflowRow, { type WorkflowRowData } from "@/components/WorkflowRow";
import ProjectActions from "@/components/ProjectActions";
import { getColor } from "@/lib/colors";
import { shortDate } from "@/lib/format";

export default async function ProjectDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await requireUser();

  const project = await prisma.project.findUnique({
    where: { id },
    include: {
      creator: { select: { email: true } },
      brand: { select: { id: true, name: true, slug: true } },
      _count: { select: { workflows: true } },
    },
  });

  if (!project) notFound();

  const workflows = await prisma.workflow.findMany({
    where: { projectId: id },
    orderBy: { updatedAt: "desc" },
  });

  const color = getColor(project.color);

  return (
    <div className="grain min-h-screen">
      <TopNav
        activeNav={project.brand ? "brands" : "projects"}
        crumbs={[
          { label: "Dashboard", href: "/dashboard" },
          ...(project.brand
            ? [
                { label: "Brands", href: "/brands" },
                { label: project.brand.name, href: `/brands/${project.brand.slug}` },
              ]
            : [{ label: "Projects", href: "/projects" }]),
          { label: project.name },
        ]}
      />

      <main className="max-w-7xl mx-auto px-6 lg:px-12 py-12">
        {/* Project hero */}
        <div className="grid lg:grid-cols-[2fr,1fr] gap-8 mb-12">
          <div>
            <div className="flex items-center gap-3 mb-4 flex-wrap">
              <div
                className={`w-10 h-10 rounded-sm ${color.bg} border ${color.border} flex items-center justify-center`}
              >
                <div className={`w-2.5 h-2.5 rounded-full ${color.dot}`} />
              </div>
              <div className="font-mono text-xs tracking-[0.2em] uppercase text-fg-muted">
                Project
              </div>
              {project.brand && (
                <a
                  href={`/brands/${project.brand.slug}`}
                  className="font-mono text-xs tracking-[0.2em] uppercase text-brand hover:text-emerald-300 border border-emerald-500/30 hover:border-emerald-500/60 px-2 py-1 rounded-sm transition"
                >
                  {project.brand.name}
                </a>
              )}
              {project.brand && (
                <a
                  href={`/brands/${project.brand.slug}/brand-kit`}
                  className="font-mono text-xs tracking-[0.2em] uppercase text-fg-muted hover:text-fg border border-border hover:border-fg-subtle px-2 py-1 rounded-sm transition"
                >
                  Brand Kit
                </a>
              )}
            </div>
            <h1 className="font-display text-5xl md:text-6xl leading-tight mb-3">
              {project.name}
            </h1>
            {project.description ? (
              <p className="text-fg text-lg leading-relaxed max-w-2xl">
                {project.description}
              </p>
            ) : (
              <p className="text-fg-subtle italic">No description.</p>
            )}
          </div>

          <div className="lg:pl-8 lg:border-l border-border flex flex-col">
            <div className="font-mono text-[10px] tracking-[0.2em] uppercase text-fg-muted mb-4">
              Project record
            </div>
            <dl className="space-y-3 text-sm">
              <div className="flex justify-between gap-4 pb-3 border-b border-border">
                <dt className="text-fg-muted">Workflows</dt>
                <dd className="font-mono tabular">{project._count.workflows}</dd>
              </div>
              <div className="flex justify-between gap-4 pb-3 border-b border-border">
                <dt className="text-fg-muted">Created</dt>
                <dd className="font-mono text-xs">{shortDate(project.createdAt)}</dd>
              </div>
              <div className="flex justify-between gap-4 pb-3 border-b border-border">
                <dt className="text-fg-muted">Created by</dt>
                <dd className="font-mono text-xs truncate max-w-[200px]">
                  {project.creator.email}
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-fg-muted">Updated</dt>
                <dd className="font-mono text-xs">{shortDate(project.updatedAt)}</dd>
              </div>
            </dl>
            <div className="mt-auto pt-6">
              <ProjectActions
                project={{
                  id: project.id,
                  name: project.name,
                  description: project.description,
                }}
                variant="inline"
              />
            </div>
          </div>
        </div>

        {/* Workflows section */}
        <section>
          <div className="flex items-end justify-between mb-6">
            <div>
              <div className="font-mono text-[10px] tracking-[0.2em] uppercase text-fg-muted mb-1">
                {workflows.length} workflow{workflows.length === 1 ? "" : "s"}
              </div>
              <h2 className="font-display text-3xl">Workflows</h2>
            </div>
            {workflows.length > 0 && (
              <CreateWorkflowButton projectId={project.id} variant="ghost" />
            )}
          </div>

          {workflows.length === 0 ? (
            <div className="bg-bg border border-dashed border-border-strong rounded-sm py-16 px-6 text-center">
              <div className="font-mono text-[10px] tracking-[0.2em] uppercase text-fg-muted mb-4">
                No workflows yet
              </div>
              <h3 className="font-display text-3xl mb-3">Create your first workflow.</h3>
              <p className="text-fg-muted text-sm mb-6 max-w-md mx-auto leading-relaxed">
                Workflows are where you build node graphs to generate creatives.
              </p>
              <CreateWorkflowButton projectId={project.id} variant="primary" />
            </div>
          ) : (
            <div className="bg-bg border border-border rounded-sm overflow-hidden">
              {workflows.map((wf: WorkflowRowData) => (
                <WorkflowRow key={wf.id} workflow={wf} />
              ))}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
