"use client";

import { useEffect, useState } from "react";
import { Check, Package } from "lucide-react";

// ─────────────────────────────────────────────────────────────────────────────
// BrandAssetsPicker — UI for the Brand Assets canvas node.
//
// Loads the brand's UI screenshots from /api/brand-assets/[brandId] and
// renders them as a grid of checkboxes. The user picks which screenshots
// will flow downstream when this node runs. Selection is persisted in
// node.config.selected (array of CDN URLs).
//
// Behaviour:
//   • Empty kit → shows a helpful empty state with a link hint.
//   • Nothing selected → runner will use ALL screenshots ("select all"
//     implicit). Shows a banner explaining this.
//   • Selection auto-saves via onConfigChange — same path as every other
//     node setting, so it survives refresh through the autosave loop.
// ─────────────────────────────────────────────────────────────────────────────

export default function BrandAssetsPicker({
  brandId,
  brandSlug,
  selected,
  onChange,
}: {
  brandId: string | null;
  brandSlug: string | null;
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const [urls, setUrls] = useState<string[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!brandId) {
      setUrls([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/brand-assets/${brandId}`, {
          cache: "no-store",
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { urls?: string[] };
        if (!cancelled) setUrls(data.urls ?? []);
      } catch (err) {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : String(err));
          setUrls([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [brandId]);

  // Sanitize selected against current urls — drops stale URLs from selection
  // so we don't ship deleted screenshots downstream.
  useEffect(() => {
    if (!urls) return;
    const filtered = selected.filter((u) => urls.includes(u));
    if (filtered.length !== selected.length) {
      onChange(filtered);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urls]);

  function toggle(u: string) {
    if (selected.includes(u)) onChange(selected.filter((v) => v !== u));
    else onChange([...selected, u]);
  }

  function selectAll() {
    onChange(urls ?? []);
  }

  function clearAll() {
    onChange([]);
  }

  if (!brandId) {
    return (
      <div className="text-[11px] text-fg-muted p-3 bg-bg-subtle border border-border rounded-md">
        This workflow isn&apos;t inside a brand, so there&apos;s no Brand Kit
        to read from.
      </div>
    );
  }

  if (urls === null) {
    return (
      <div className="text-[11px] text-fg-muted p-3 bg-bg-subtle border border-border rounded-md">
        Loading brand screenshots…
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="text-[11px] text-red-500 p-3 bg-bg-subtle border border-border rounded-md">
        Failed to load: {loadError}
      </div>
    );
  }

  if (urls.length === 0) {
    return (
      <div className="text-[11px] text-fg-muted p-3 bg-bg-subtle border border-border rounded-md">
        <div className="flex items-center gap-1.5 mb-1.5 text-fg">
          <Package size={11} />
          <span className="font-medium">No screenshots in Brand Kit</span>
        </div>
        Add UI screenshots on the{" "}
        {brandSlug ? (
          <a
            href={`/brands/${brandSlug}/brand-kit`}
            className="text-brand hover:underline"
            target="_blank"
            rel="noopener noreferrer"
            onMouseDown={(e) => e.stopPropagation()}
          >
            brand kit page
          </a>
        ) : (
          "brand kit page"
        )}{" "}
        to use this node.
      </div>
    );
  }

  const allSelected = selected.length === urls.length;
  const noneSelected = selected.length === 0;
  const effectiveCount = noneSelected ? urls.length : selected.length;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-[10px] text-fg-muted">
        <span>
          {noneSelected
            ? `All ${urls.length} will be used`
            : `${selected.length} of ${urls.length} selected`}
        </span>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={selectAll}
            onMouseDown={(e) => e.stopPropagation()}
            disabled={allSelected}
            className="text-fg-muted hover:text-fg disabled:opacity-40"
          >
            All
          </button>
          <button
            type="button"
            onClick={clearAll}
            onMouseDown={(e) => e.stopPropagation()}
            disabled={noneSelected}
            className="text-fg-muted hover:text-fg disabled:opacity-40"
          >
            None
          </button>
        </div>
      </div>

      <div
        className="grid grid-cols-3 gap-1.5 nodrag"
        onMouseDown={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
      >
        {urls.map((u) => {
          const isOn = selected.includes(u);
          // If nothing is selected, all are "implicitly active" — visually
          // dim/lift the same way so users understand the rule.
          const visuallyActive = isOn || noneSelected;
          return (
            <button
              key={u}
              type="button"
              onClick={() => toggle(u)}
              className={`relative aspect-[9/16] rounded-md overflow-hidden border transition ${
                isOn
                  ? "border-brand ring-1 ring-brand"
                  : visuallyActive
                    ? "border-border"
                    : "border-border opacity-40"
              }`}
              title={u}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={u}
                alt=""
                className="w-full h-full object-cover"
                loading="lazy"
                draggable={false}
              />
              {isOn && (
                <div className="absolute top-1 right-1 w-4 h-4 bg-brand rounded-full flex items-center justify-center">
                  <Check size={9} className="text-white" />
                </div>
              )}
            </button>
          );
        })}
      </div>

      <p className="text-[10px] text-fg-muted">
        {effectiveCount} screenshot{effectiveCount === 1 ? "" : "s"} will flow
        into the next node when this runs.
      </p>
    </div>
  );
}
