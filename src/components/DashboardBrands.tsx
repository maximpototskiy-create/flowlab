"use client";
import { useState } from "react";
import BrandCard, { type BrandCardData, type BrandProject } from "./BrandCard";

// Dashboard brands grid: shows the 4 most recent by default and can expand the
// FULL list inline (no navigation). Each card is itself expandable to reveal the
// brand's projects, which are clickable to open. So: expand the list → expand a
// brand → open.
export default function DashboardBrands({
  brands,
}: {
  brands: (BrandCardData & { projects: BrandProject[] })[];
}) {
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? brands : brands.slice(0, 4);

  return (
    <>
      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4 items-start">
        {shown.map((b) => (
          <BrandCard key={b.id} brand={b} projects={b.projects} />
        ))}
      </div>

      {brands.length > 4 && (
        <div className="mt-5 flex justify-center">
          <button
            type="button"
            onClick={() => setShowAll((s) => !s)}
            className="text-[12px] font-medium text-fg-muted hover:text-fg border border-[rgb(var(--hairline)/var(--hairline-alpha))] hover:bg-bg-hover px-4 py-2 rounded-lg transition"
          >
            {showAll ? "Show less" : `Show all ${brands.length} brands`}
          </button>
        </div>
      )}
    </>
  );
}
