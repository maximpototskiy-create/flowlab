// src/components/BrandCard.tsx
import Link from "next/link";
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

export default function BrandCard({ brand }: { brand: BrandCardData }) {
  const color = getColor(brand.color);

  return (
    <Link
      href={`/brands/${brand.slug}`}
      className="group relative surface rounded-[var(--radius-lg)] p-5 transition hover:-translate-y-0.5 flex flex-col min-h-[200px]"
    >
      <div className="flex items-start justify-between mb-4">
        {brand.iconUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={brand.iconUrl} alt="" className={`w-12 h-12 rounded-xl object-cover border ${color.border}`} />
        ) : (
          <div className={`w-12 h-12 rounded-xl ${color.bg} border ${color.border} flex items-center justify-center`}>
            <div className={`w-3 h-3 rounded-full ${color.dot}`} />
          </div>
        )}
        <StopPropagation>
          <BrandActions brand={brand} />
        </StopPropagation>
      </div>

      <h3 className="font-display text-2xl leading-tight mb-1 group-hover:text-brand transition">
        {brand.name}
      </h3>

      <p className="text-fg-muted text-sm line-clamp-2 mb-auto">
        {brand.description || (
          <span className="italic text-fg-subtle">No description</span>
        )}
      </p>

      <div className="flex justify-between items-end font-mono text-[10px] tracking-wider uppercase text-fg-subtle mt-4 pt-3 border-t border-[rgb(var(--hairline)/var(--hairline-alpha))]">
        <span>
          {brand._count.projects} project{brand._count.projects === 1 ? "" : "s"}
        </span>
        <span>{relativeTime(brand.updatedAt)}</span>
      </div>
    </Link>
  );
}
