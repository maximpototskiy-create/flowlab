// src/components/BrandCard.tsx
"use client";
import Link from "next/link";
import { useState } from "react";
import { ChevronDown } from "lucide-react";
import BrandActions from "./BrandActions";
import StopPropagation from "./StopPropagation";
import { getColor } from "@/lib/colors";
import { relativeTime } from "@/lib/format";

export type BrandCardData = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  color: string;
  iconUrl: string | null;
  updatedAt: Date;
  _count: { projects: number };
};

export type BrandProject = {
  id: string;
  name: string;
  color: string;
  _count: { workflows: number };
};

export default function BrandCard({ brand, projects }: { brand: BrandCardData; projects?: BrandProject[] }) {
  const color = getColor(brand.color);
  const [open, setOpen] = useState(false);
  // The dashboard passes `projects` to enable inline expansion; other places
  // (e.g. the Brands page) omit it and keep the classic full-card link.
  const expandable = projects !== undefined;

  const swatch = brand.iconUrl ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={brand.iconUrl} alt="" className={`w-12 h-12 rounded-xl object-cover border ${color.border}`} />
  ) : (
    <div className={`w-12 h-12 rounded-xl ${color.bg} border ${color.border} flex items-center justify-center`}>
      <div className={`w-3 h-3 rounded-full ${color.dot}`} />
    </div>
  );

  if (!expandable) {
    return (
      <Link
        href={`/brands/${brand.slug}`}
        className="group relative surface rounded-[var(--radius-lg)] p-5 transition hover:-translate-y-0.5 flex flex-col min-h-[200px]"
      >
        <div className="flex items-start justify-between mb-4">
          {swatch}
          <StopPropagation>
            <BrandActions brand={brand} />
          </StopPropagation>
        </div>
        <h3 className="font-display text-2xl leading-tight mb-1 group-hover:text-brand transition">{brand.name}</h3>
        <p className="text-fg-muted text-sm line-clamp-2 mb-auto">
          {brand.description || <span className="italic text-fg-subtle">No description</span>}
        </p>
        <div className="flex justify-between items-end font-mono text-[10px] tracking-wider uppercase text-fg-subtle mt-4 pt-3 border-t border-[rgb(var(--hairline)/var(--hairline-alpha))]">
          <span>{brand._count.projects} project{brand._count.projects === 1 ? "" : "s"}</span>
          <span>{relativeTime(brand.updatedAt)}</span>
        </div>
      </Link>
    );
  }

  // Dashboard variant: inline-expandable to reveal the brand's projects without
  // navigating away. Header/title still link to the brand page.
  const list = projects ?? [];
  return (
    <div className="group relative surface rounded-[var(--radius-lg)] p-5 transition flex flex-col min-h-[200px]">
      <Link href={`/brands/${brand.slug}`} className="flex flex-col flex-1">
        <div className="flex items-start justify-between mb-4">
          {swatch}
          <StopPropagation>
            <BrandActions brand={brand} />
          </StopPropagation>
        </div>
        <h3 className="font-display text-2xl leading-tight mb-1 group-hover:text-brand transition">{brand.name}</h3>
        <p className="text-fg-muted text-sm line-clamp-2 mb-auto">
          {brand.description || <span className="italic text-fg-subtle">No description</span>}
        </p>
      </Link>

      <div className="flex justify-between items-center font-mono text-[10px] tracking-wider uppercase text-fg-subtle mt-4 pt-3 border-t border-[rgb(var(--hairline)/var(--hairline-alpha))]">
        <span>{brand._count.projects} project{brand._count.projects === 1 ? "" : "s"}</span>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex items-center gap-1 hover:text-fg transition"
          title={open ? "Collapse" : "Show projects"}
        >
          {open ? "Hide" : "Projects"}
          <ChevronDown size={12} className={`transition-transform ${open ? "rotate-180" : ""}`} />
        </button>
      </div>

      {open && (
        <div className="mt-3 pt-3 border-t border-[rgb(var(--hairline)/var(--hairline-alpha))] space-y-0.5 max-h-52 overflow-auto">
          {list.length === 0 ? (
            <div className="text-fg-subtle text-[12px] italic px-1 py-1">No projects yet</div>
          ) : (
            list.map((p) => {
              const pc = getColor(p.color);
              return (
                <Link
                  key={p.id}
                  href={`/projects/${p.id}`}
                  className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-bg-hover transition text-[12px]"
                >
                  <span className={`w-2 h-2 rounded-full ${pc.dot} shrink-0`} />
                  <span className="flex-1 truncate text-fg">{p.name}</span>
                  <span className="text-fg-subtle tabular-nums">{p._count.workflows}</span>
                </Link>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
