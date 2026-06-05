"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// Unified tab bar across the asset surfaces. Generated = all generations,
// Library = curated brand assets + semantic search, Archive = legacy index.
const TABS = [
  { href: "/assets", label: "Generated" },
  { href: "/library", label: "Library" },
  { href: "/asset-search", label: "Archive" },
];

export default function AssetTabs() {
  const pathname = usePathname();
  return (
    <div className="flex gap-1 border-b border-border mb-6">
      {TABS.map((t) => {
        const active = pathname === t.href || pathname?.startsWith(t.href + "/");
        return (
          <Link
            key={t.href}
            href={t.href}
            className={`px-4 py-2 text-[13px] -mb-px border-b-2 transition ${
              active ? "border-brand text-brand" : "border-transparent text-fg-muted hover:text-fg"
            }`}
          >
            {t.label}
          </Link>
        );
      })}
    </div>
  );
}
