"use client";

import { useEffect, useState, useMemo , useRef} from "react";
import { Check, Package, Music, Video as VideoIcon , Play, Pause} from "lucide-react";

// ─────────────────────────────────────────────────────────────────────────────
// BrandAssetsPicker — UI for the Brand Assets canvas node.
//
// Loads the brand's assets from /api/brand-assets/[brandId] (brand_assets —
// the single source) and renders them as a category-filterable grid of
// checkboxes. The user picks which assets flow downstream when the node runs.
// Selection is persisted in node.config.selected (array of URLs).
//
//   • Filter chips by category (logo / ui / store / hook / music / …).
//   • Nothing selected → runner forwards ALL (implicit "everything").
//   • Selection auto-saves via onChange.
// ─────────────────────────────────────────────────────────────────────────────

type Asset = { url: string; kind: string; category: string; label: string | null };

// Aspect-ratio bucket from a measured "W×H" string (matches the asset drawer,
// the /assets page and the editor — identical buckets/tolerance everywhere).
function bucketFromDim(d: string | undefined): string | null {
  if (!d) return null;
  const m = d.match(/(\d+)×(\d+)/); if (!m) return null;
  const w = +m[1], h = +m[2]; if (!w || !h) return null;
  const r = w / h;
  const near = (t: number) => Math.abs(r - t) / t < 0.06;
  if (near(1)) return "1:1";
  if (near(4 / 5)) return "4:5";
  if (near(9 / 16)) return "9:16";
  if (near(16 / 9)) return "16:9";
  if (near(3 / 4)) return "3:4";
  if (near(2 / 3)) return "2:3";
  return r < 1 ? "Portrait" : "Landscape";
}

const CAT_LABEL: Record<string, string> = {
  logo: "Logo",
  ui: "UI",
  store: "Store",
  graphic: "Graphic",
  overlay: "Overlay",
  music: "Music",
  sound: "Sound",
  reference: "Reference",
  hook: "Hook",
  body: "Body",
  packshot: "Packshot",
  other: "Other",
};

export default function BrandAssetsPicker({
  brandId,
  brandSlug,
  selected,
  onChange,
  expanded = false,
}: {
  brandId: string | null;
  brandSlug: string | null;
  selected: string[];
  onChange: (next: string[]) => void;
  expanded?: boolean;
}) {
  const gridRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = gridRef.current; if (!el) return;
    const stop = (e: WheelEvent) => e.stopPropagation();
    el.addEventListener("wheel", stop, { passive: true });
    return () => el.removeEventListener("wheel", stop);
  }, []);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  const [previewingUrl, setPreviewingUrl] = useState<string | null>(null);
  const togglePreview = (url: string) => {
    const cur = previewAudioRef.current;
    if (previewingUrl === url && cur) { cur.pause(); setPreviewingUrl(null); return; }
    if (cur) cur.pause();
    const a = new Audio(url); a.volume = 0.9; a.onended = () => setPreviewingUrl(null);
    previewAudioRef.current = a; setPreviewingUrl(url);
    a.play().catch(() => setPreviewingUrl(null));
  };
  useEffect(() => () => { previewAudioRef.current?.pause(); }, []);
  const [assets, setAssets] = useState<Asset[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>("all");
  const [aspect, setAspect] = useState<string>("all");
  const [dims, setDims] = useState<Record<string, string>>({});
  const noteDims = (url: string, w: number, h: number) => { if (w && h) setDims((p) => (p[url] ? p : { ...p, [url]: `${w}×${h}` })); };

  useEffect(() => {
    if (!brandId) {
      setAssets([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/brand-assets/${brandId}`, { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { assets?: Asset[] };
        if (!cancelled) setAssets(data.assets ?? []);
      } catch (err) {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : String(err));
          setAssets([]);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [brandId]);

  const allUrls = useMemo(() => (assets ?? []).map((a) => a.url), [assets]);

  // Drop stale URLs from selection.
  useEffect(() => {
    if (!assets) return;
    const filtered = selected.filter((u) => allUrls.includes(u));
    if (filtered.length !== selected.length) onChange(filtered);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assets]);

  // Eagerly measure dimensions so the aspect-ratio filter can bucket assets
  // even before their thumbnail scrolls into view (videos load metadata only).
  useEffect(() => {
    const els: HTMLMediaElement[] = [];
    for (const a of assets ?? []) {
      if (dims[a.url]) continue;
      if (a.kind === "image") {
        const img = new Image();
        img.onload = () => noteDims(a.url, img.naturalWidth, img.naturalHeight);
        img.src = a.url;
      } else if (a.kind === "video") {
        const v = document.createElement("video");
        v.preload = "metadata"; v.muted = true;
        v.onloadedmetadata = () => noteDims(a.url, v.videoWidth, v.videoHeight);
        v.src = a.url; els.push(v);
      }
    }
    return () => { els.forEach((e) => { e.onloadedmetadata = null; e.src = ""; }); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assets]);

  const categories = useMemo(() => {
    const set = new Set((assets ?? []).map((a) => a.category));
    return ["all", ...Array.from(set)];
  }, [assets]);

  const visible = useMemo(
    () => (assets ?? []).filter((a) =>
      (filter === "all" || a.category === filter) &&
      (aspect === "all" || a.kind === "audio" || bucketFromDim(dims[a.url]) === aspect)),
    [assets, filter, aspect, dims],
  );

  function toggle(u: string) {
    if (selected.includes(u)) onChange(selected.filter((v) => v !== u));
    else onChange([...selected, u]);
  }

  if (!brandId) {
    return (
      <div className="text-[11px] text-fg-muted p-3 bg-bg-subtle r-sm hairline">
        This workflow isn&apos;t inside a brand, so there&apos;s no Brand Kit to read from.
      </div>
    );
  }
  if (assets === null) {
    return (
      <div className="text-[11px] text-fg-muted p-3 bg-bg-subtle r-sm hairline">
        Loading assets…
      </div>
    );
  }
  if (loadError) {
    return (
      <div className="text-[11px] text-red-500 p-3 bg-bg-subtle r-sm hairline">
        Failed to load: {loadError}
      </div>
    );
  }
  if (assets.length === 0) {
    return (
      <div className="text-[11px] text-fg-muted p-3 bg-bg-subtle r-sm hairline">
        <div className="flex items-center gap-1.5 mb-1.5 text-fg">
          <Package size={11} />
          <span className="font-medium">No brand assets yet</span>
        </div>
        Add assets on the{" "}
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

  const noneSelected = selected.length === 0;
  const effectiveCount = noneSelected ? allUrls.length : selected.length;

  return (
    <div className="space-y-2 nodrag" onMouseDown={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
      {/* Category filter chips */}
      <div className="flex flex-wrap gap-1">
        {categories.map((c) => (
          <button
            key={c}
            type="button"
            onMouseDown={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              setFilter(c);
            }}
            className={`px-2 py-0.5 rounded-full text-[10px] border transition ${
              filter === c ? "bg-brand/15 border-brand text-brand" : "border-border text-fg-muted hover:text-fg"
            }`}
          >
            {c === "all" ? "All" : CAT_LABEL[c] ?? c}
          </button>
        ))}
      </div>

      <div className="flex items-center gap-1.5">
        <span className="text-[9px] uppercase tracking-wider text-fg-subtle shrink-0">Ratio</span>
        <select
          value={aspect}
          onChange={(e) => { e.stopPropagation(); setAspect(e.target.value); }}
          onMouseDown={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          className="flex-1 bg-bg border border-border rounded px-1 py-0.5 text-[10px] text-fg-muted outline-none nodrag"
        >
          <option value="all">All ratios</option>
          <option value="1:1">1:1 · square</option>
          <option value="4:5">4:5 · portrait</option>
          <option value="9:16">9:16 · story</option>
          <option value="16:9">16:9 · wide</option>
          <option value="3:4">3:4</option>
          <option value="2:3">2:3</option>
          <option value="Portrait">Other portrait</option>
          <option value="Landscape">Other landscape</option>
        </select>
      </div>

      <div className="flex items-center justify-between text-[10px] text-fg-muted">
        <span>{noneSelected ? `All ${allUrls.length} will be used` : `${selected.length} selected`}</span>
        <div className="flex gap-2">
          <button
            type="button"
            onMouseDown={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); onChange(allUrls); }}
            className="text-fg-muted hover:text-fg"
          >
            All
          </button>
          <button
            type="button"
            onMouseDown={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); onChange([]); }}
            disabled={noneSelected}
            className="text-fg-muted hover:text-fg disabled:opacity-40"
          >
            None
          </button>
        </div>
      </div>

      {/* Grid */}
      <div
        ref={gridRef}
        className={`grid gap-1.5 overflow-y-auto pr-1 ${expanded ? "grid-cols-4 max-h-[480px]" : "grid-cols-3 max-h-[240px]"}`}
      >
        {visible.map((a) => {
          const isOn = selected.includes(a.url);
          const visuallyActive = isOn || noneSelected;
          return (
            <button
              key={a.url}
              type="button"
              onMouseDown={(e) => e.stopPropagation()}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); toggle(a.url); }}
              onMouseEnter={(e) => { const v = e.currentTarget.querySelector("video"); if (v) (v as HTMLVideoElement).play().catch(() => {}); }}
              onMouseLeave={(e) => { const v = e.currentTarget.querySelector("video"); if (v) { (v as HTMLVideoElement).pause(); (v as HTMLVideoElement).currentTime = 0; } }}
              className={`relative aspect-[9/16] rounded-md overflow-hidden border transition ${
                isOn ? "border-brand ring-1 ring-brand" : visuallyActive ? "border-border" : "border-border opacity-40"
              }`}
              title={a.label ?? a.url}
            >
              {a.kind === "image" && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={a.url} alt="" onLoad={(e) => noteDims(a.url, e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)} className="w-full h-full object-cover" loading="lazy" draggable={false} />
              )}
              {a.kind === "video" && (
                <div className="w-full h-full flex items-center justify-center bg-black">
                  <video src={a.url} onLoadedMetadata={(e) => noteDims(a.url, e.currentTarget.videoWidth, e.currentTarget.videoHeight)} className="w-full h-full object-cover pointer-events-none" muted loop preload="metadata" />
                  <VideoIcon size={14} className="absolute text-white/80 pointer-events-none" />
                </div>
              )}
              {a.kind === "audio" && (
                <div className="w-full h-full flex items-center justify-center relative"><Music size={16} className="text-fg-subtle" />
                  <span role="button" tabIndex={0}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => { e.stopPropagation(); togglePreview(a.url); }}
                    title={previewingUrl === a.url ? "Stop" : "Preview"}
                    className="absolute bottom-1 right-1 w-6 h-6 grid place-items-center rounded-full bg-black/70 text-white hover:bg-black/90 cursor-pointer">
                    {previewingUrl === a.url ? <Pause size={11} /> : <Play size={11} />}
                  </span>
                </div>
              )}
              <span className="absolute top-1 left-1 px-1 rounded bg-black/55 text-[7px] uppercase text-white/85">
                {CAT_LABEL[a.category] ?? a.category}
              </span>
              {dims[a.url] && <span className="absolute bottom-1 left-1 px-1 rounded bg-black/55 text-[7px] text-white/75">{dims[a.url]}</span>}
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
        {effectiveCount} asset{effectiveCount === 1 ? "" : "s"} will flow into the next node when this runs.
      </p>
    </div>
  );
}
