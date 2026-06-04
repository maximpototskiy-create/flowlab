"use client";

import { useEffect, useState } from "react";
import { BookmarkPlus, Check, Loader2 } from "lucide-react";

type Brand = { id: string; name: string; slug: string };

const CATEGORIES = ["logo", "ui", "store", "graphic", "overlay", "music", "sound", "reference", "hook", "body", "packshot", "other"];

// Save a generated/library Asset into a brand's curated assets (auto-embeds).
// If `brandId` is provided (e.g. on the canvas), the brand picker is hidden.
export default function SaveToLibraryButton({
  url,
  kind,
  label,
  brandId,
  compact,
}: {
  url: string;
  kind?: string;
  label?: string;
  brandId?: string | null;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [brands, setBrands] = useState<Brand[]>([]);
  const [selBrand, setSelBrand] = useState<string>(brandId ?? "");
  const [category, setCategory] = useState<string>("reference");
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || brandId || brands.length) return;
    fetch("/api/brands")
      .then((r) => r.json())
      .then((d) => {
        setBrands(d.brands ?? []);
        if (!selBrand && d.brands?.[0]) setSelBrand(d.brands[0].id);
      })
      .catch(() => {});
  }, [open, brandId, brands.length, selBrand]);

  async function save() {
    const useBrand = brandId ?? selBrand;
    if (!useBrand) {
      setError("Pick a brand");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/brand-assets/from-asset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, kind, label, brandId: useBrand, category }),
      });
      const d = await res.json();
      if (d.error) setError(d.error);
      else {
        setDone(true);
        setTimeout(() => {
          setOpen(false);
          setDone(false);
        }, 1200);
      }
    } catch {
      setError("Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex items-center gap-1.5 rounded-md border border-border text-fg-muted hover:text-fg transition ${
          compact ? "px-2 py-1 text-[11px]" : "px-3 py-2 text-[12px]"
        }`}
        title="Save to brand library (makes it searchable)"
      >
        <BookmarkPlus size={13} /> Save to library
      </button>

      {open && (
        <div
          className="absolute right-0 bottom-full mb-2 z-50 w-60 rounded-lg border border-border bg-bg-card p-3 shadow-xl space-y-2"
          onClick={(e) => e.stopPropagation()}
        >
          {!brandId && (
            <div>
              <label className="text-[9px] uppercase tracking-wider text-fg-subtle">Brand</label>
              <select
                value={selBrand}
                onChange={(e) => setSelBrand(e.target.value)}
                className="mt-1 w-full bg-bg border border-border rounded-md p-1.5 text-[12px] text-fg outline-none focus:border-brand"
              >
                {brands.length === 0 && <option value="">Loading…</option>}
                {brands.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div>
            <label className="text-[9px] uppercase tracking-wider text-fg-subtle">Category</label>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="mt-1 w-full bg-bg border border-border rounded-md p-1.5 text-[12px] text-fg outline-none focus:border-brand"
            >
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
          {error && <p className="text-[10px] text-red-400">{error}</p>}
          <button
            type="button"
            onClick={save}
            disabled={saving || done}
            className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md bg-brand text-black font-medium text-[12px] disabled:opacity-60"
          >
            {saving ? <Loader2 size={13} className="animate-spin" /> : done ? <Check size={13} /> : <BookmarkPlus size={13} />}
            {done ? "Saved · indexing" : saving ? "Saving…" : "Save"}
          </button>
        </div>
      )}
    </div>
  );
}
