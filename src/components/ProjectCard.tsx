// src/components/ProjectCard.tsx
import Link from "next/link";
import ProjectActions from "./ProjectActions";
import StopPropagation from "./StopPropagation";
import { getColor } from "@/lib/colors";
import { relativeTime } from "@/lib/format";

export type ProjectCardData = {
  id: string;
  name: string;
  description: string | null;
  color: string;
  updatedAt: Date;
  _count: { workflows: number };
  /** Project owner - shown on the card so it is clear who runs what. */
  creator?: { name: string | null; email: string } | null;
};

export default function ProjectCard({ project }: { project: ProjectCardData }) {
  const color = getColor(project.color);

  return (
    <Link
      href={`/projects/${project.id}`}
      className="group relative bg-bg border border-border hover:border-border-strong rounded-sm p-5 transition flex flex-col min-h-[180px]"
    >
      <div className="flex items-start justify-between mb-3">
        <div className={`w-8 h-8 rounded-sm ${color.bg} border ${color.border} flex items-center justify-center`}>
          <div className={`w-2 h-2 rounded-full ${color.dot}`} />
        </div>
        <StopPropagation>
          <ProjectActions project={project} />
        </StopPropagation>
      </div>

      <h3 className="font-display text-xl leading-tight mb-1 group-hover:text-brand transition line-clamp-2 [overflow-wrap:anywhere]">
        {project.name}
      </h3>

      <p className="text-fg-muted text-sm line-clamp-2 mb-auto">
        {project.description || (
          <span className="italic text-fg-subtle">No description</span>
        )}
      </p>

      {project.creator && (
        <div className="font-mono text-[10px] tracking-wider uppercase text-fg-subtle mt-3 truncate" title={project.creator.email}>
          by {project.creator.name || project.creator.email.split("@")[0]}
        </div>
      )}
      <div className={`flex justify-between items-end font-mono text-[10px] tracking-wider uppercase text-fg-subtle ${project.creator ? "mt-1.5" : "mt-4"} pt-3 border-t border-border`}>
        <span>
          {project._count.workflows} workflow{project._count.workflows === 1 ? "" : "s"}
        </span>
        <span>{relativeTime(project.updatedAt)}</span>
      </div>
    </Link>
  );
}
