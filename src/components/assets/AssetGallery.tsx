"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import Image from "next/image";
import { useRouter, useSearchParams } from "next/navigation";
import { Search, Download, X, Image as ImageIcon, Video, Music, FileText, Trash2, Loader2 } from "lucide-react";
import type { AssetItem, FilterOption } from "@/lib/assetsQuery";
import SaveToLibraryButton from "@/components/SaveToLibraryButton";

export type { AssetItem, FilterOption };

const KINDS = [
  { value: "image", label: "Images", icon: ImageIcon },
  { value: "video", label: "Video", icon: Video },
  { value: "audio", label: "Audio", icon: Music },
  { value: "text", label: "Text", icon: FileText },
];
const SOURCES = [
  { value: "generated", label: "Generated" },
  { value: "upload", label: "Uploads" },
  { value: "brand_kit", label: "Brand kit" },
];

// How many cards to mount initially / per "page" of infinite scroll.
// Keeping this small is the single biggest perf win on /assets: it caps how
// many DOM nodes (and especially how many <video> metadata fetches) mount on
// first paint instead of all ~240 at once (TBT was ~1.8s before this).
const PAGE = 48;

// Bucket an asset into a standard aspect ratio from its stored pixel size.
function aspectBucketWH(w?: number | null, h?: number | null): string | null {
  if (!w || !h) return null;
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

// Existing rows may carry a stale kind="text" for what is really an image or
// video (old inferKind bug). Every Asset cdnUrl is an http media URL — text
// outputs were never stored — so re-derive the real kind from the URL.
function effectiveKind(a: AssetItem): string {
  if (a.kind !== "text") return a.kind;
  const u = (a.cdnUrl ?? "").split("?")[0].toLowerCase();
  if (/\.(mp4|webm|mov|m4v)$/.test(u)) return "video";
  if (/\.(mp3|wav|m4a|ogg|aac|flac)$/.test(u)) return "audio";
  if ((a.cdnUrl ?? "").startsWith("http")) return "image";
  return "text";
}

// Whether next/image can optimize this URL. Must mirror next.config.ts
// images.remotePatterns — using <Image> on a host that isn't whitelisted throws
// "hostname not configured" at runtime. Anything else falls back to plain <img>
// (rare external brand-kit URLs) so it degrades gracefully instead of breaking.
function canOptimize(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  return (
    host === "supabase.co" || host.endsWith(".supabase.co") ||
    host === "fal.media" || host.endsWith(".fal.media") ||
    host === "storage.googleapis.com"
  );
}

function fmtSize(b: number | null) {
  if (!b) return null;
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}
function fmtDur(s: number | null) {
  if (!s) return null;
  const m = Math.floor(s / 60);
  const sec = Math.round(s % 60);
  return m > 0 ? `${m}:${sec.toString().padStart(2, "0")}` : `${sec}s`;
}

export default function AssetGallery({
  assets,
  projects,
  brands,
  active,
}: {
  assets: AssetItem[];
  projects: FilterOption[];
  brands: FilterOption[];
  active: { project?: string; brand?: string; kind?: string; source?: string; q?: string; sort?: string };
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [lightbox, setLightbox] = useState<AssetItem | null>(null);
  const [search, setSearch] = useState(active.q ?? "");
  const [aspect, setAspect] = useState("all");
  // Client-side aspect-ratio (resolution) filter over the loaded list.
  const filtered = aspect === "all" ? assets : assets.filter((a) => aspectBucketWH(a.width, a.height) === aspect);

  // ── Client-side windowing (infinite scroll) ──
  // Render `visible` cards; a sentinel below the grid bumps it by PAGE when it
  // scrolls into view. Reset whenever the asset set changes (new filter).
  const [visible, setVisible] = useState(PAGE);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setVisible(PAGE);
  }, [assets, aspect]);

  useEffect(() => {
    if (visible >= filtered.length) return;
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible((v) => Math.min(v + PAGE, filtered.length));
        }
      },
      { rootMargin: "800px" }, // start loading the next page well before it's on screen
    );
    io.observe(el);
    return () => io.disconnect();
  }, [filtered.length, visible]);

  // Update one filter key in the URL (null clears it). Keeps the rest.
  const setFilter = useCallback(
    (key: string, value: string | null) => {
      const next = new URLSearchParams(params.toString());
      if (value) next.set(key, value);
      else next.delete(key);
      router.push(`/assets?${next.toString()}`);
    },
    [params, router],
  );

  // Toggle a chip filter (click active one again to clear).
  const toggle = (key: string, value: string) =>
    setFilter(key, active[key as keyof typeof active] === value ? null : value);

  const hasFilters = active.project || active.brand || active.kind || active.source || active.q;
  const shown = filtered.slice(0, visible);

  return (
    <div>
      {/* ── Filter bar ── */}
      <div className="flex flex-wrap items-center gap-2 mb-6">
        {/* Search */}
        <div className="relative">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-subtle" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") setFilter("q", search.trim() || null); }}
            placeholder="Search by prompt…"
            className="bg-bg-card border border-[rgb(var(--hairline)/var(--hairline-alpha))] rounded-md pl-8 pr-3 py-1.5 text-[12px] text-fg w-56 outline-none focus:border-brand"
          />
        </div>

        {/* Kind chips */}
        <div className="flex items-center gap-1">
          {KINDS.map((k) => {
            const on = active.kind === k.value;
            const Icon = k.icon;
            return (
              <button
                key={k.value}
                onClick={() => toggle("kind", k.value)}
                className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[11px] border transition ${
                  on ? "bg-brand/15 border-brand text-brand" : "border-border text-fg-muted hover:text-fg hover:border-border-strong"
                }`}
              >
                <Icon size={12} /> {k.label}
              </button>
            );
          })}
        </div>

        {/* Source chips */}
        <div className="flex items-center gap-1">
          {SOURCES.map((s) => {
            const on = active.source === s.value;
            return (
              <button
                key={s.value}
                onClick={() => toggle("source", s.value)}
                className={`px-2.5 py-1.5 rounded-md text-[11px] border transition ${
                  on ? "bg-brand/15 border-brand text-brand" : "border-border text-fg-muted hover:text-fg hover:border-border-strong"
                }`}
              >
                {s.label}
              </button>
            );
          })}
        </div>

        {/* Project / brand selects */}
        <select
          value={active.project ?? ""}
          onChange={(e) => setFilter("project", e.target.value || null)}
          className="bg-bg-card border border-[rgb(var(--hairline)/var(--hairline-alpha))] rounded-md px-2 py-1.5 text-[11px] text-fg-muted outline-none focus:border-brand"
        >
          <option value="">All projects</option>
          {projects.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
        </select>
        <select
          value={active.brand ?? ""}
          onChange={(e) => setFilter("brand", e.target.value || null)}
          className="bg-bg-card border border-[rgb(var(--hairline)/var(--hairline-alpha))] rounded-md px-2 py-1.5 text-[11px] text-fg-muted outline-none focus:border-brand"
        >
          <option value="">All brands</option>
          {brands.map((b) => <option key={b.value} value={b.value}>{b.label}</option>)}
        </select>
        <select
          value={active.sort ?? "newest"}
          onChange={(e) => setFilter("sort", e.target.value === "newest" ? null : e.target.value)}
          className="bg-bg-card border border-[rgb(var(--hairline)/var(--hairline-alpha))] rounded-md px-2 py-1.5 text-[11px] text-fg-muted outline-none focus:border-brand"
          title="Sort by date"
        >
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
        </select>
        <select
          value={aspect}
          onChange={(e) => setAspect(e.target.value)}
          className="bg-bg-card border border-[rgb(var(--hairline)/var(--hairline-alpha))] rounded-md px-2 py-1.5 text-[11px] text-fg-muted outline-none focus:border-brand"
          title="Filter by aspect ratio (resolution)"
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

        {hasFilters && (
          <button
            onClick={() => router.push("/assets")}
            className="px-2.5 py-1.5 rounded-md text-[11px] text-fg-subtle hover:text-fg"
          >
            Clear
          </button>
        )}
      </div>

      {/* ── Grid ── */}
      {assets.length === 0 ? (
        <div className="rounded-[var(--radius-lg)] border border-dashed border-[rgb(var(--hairline)/0.18)] bg-bg-card/40 py-20 text-center">
          <h3 className="font-display text-3xl mb-2">Nothing here yet.</h3>
          <p className="text-fg-muted text-sm">Generate or upload assets and they'll show up here.</p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-[var(--radius-lg)] border border-dashed border-[rgb(var(--hairline)/0.18)] bg-bg-card/40 py-20 text-center">
          <h3 className="font-display text-2xl mb-2">No assets in this ratio.</h3>
          <p className="text-fg-muted text-sm">Try a different aspect-ratio filter, or pick “All ratios”.</p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
            {shown.map((a) => {
              const ek = effectiveKind(a);
              return (
              <button
                key={a.id}
                onClick={() => setLightbox(a)}
                className="group relative aspect-square rounded-[var(--radius)] overflow-hidden bg-bg-card border border-[rgb(var(--hairline)/var(--hairline-alpha))] hover:border-brand/50 hover:elev-2 transition text-left"
              >
                <AssetThumb asset={a} ek={ek} />
                {/* hover meta — prompt if present, else model/source */}
                <div className="absolute inset-x-0 bottom-0 p-2 bg-gradient-to-t from-black/80 to-transparent opacity-0 group-hover:opacity-100 transition">
                  <div className="text-[9px] text-white/90 line-clamp-2 leading-snug">
                    {a.prompt || a.model || a.source}
                  </div>
                </div>
                <span className="absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded bg-black/50 text-[8px] uppercase tracking-wide text-white/80">
                  {ek}
                </span>
              </button>
              );
            })}
          </div>

          {/* Infinite-scroll sentinel — bumps `visible` by PAGE when reached */}
          {visible < filtered.length && (
            <div ref={sentinelRef} className="py-8 text-center text-fg-subtle text-[11px]">
              Loading more… ({visible} / {filtered.length})
            </div>
          )}
        </>
      )}

      {/* ── Lightbox ── */}
      {lightbox && <Lightbox asset={lightbox} onClose={() => setLightbox(null)} onDeleted={() => { setLightbox(null); router.refresh(); }} />}
    </div>
  );
}

function AssetThumb({ asset, ek }: { asset: AssetItem; ek: string }) {
  if (ek === "image") {
    return <ImageThumb url={asset.cdnUrl} />;
  }
  if (ek === "video") {
    return <LazyVideoThumb src={asset.cdnUrl} />;
  }
  if (ek === "audio") {
    return (
      <div className="w-full h-full flex items-center justify-center text-fg-subtle">
        <Music size={28} />
      </div>
    );
  }
  return (
    <div className="w-full h-full flex items-center justify-center p-3 text-fg-muted text-[10px] leading-snug overflow-hidden">
      {asset.prompt ? asset.prompt.slice(0, 140) : <FileText size={28} />}
    </div>
  );
}

// Grid image thumbnail. For Supabase/fal-hosted images we use next/image so
// Vercel serves a small WebP at grid size (was shipping full-res originals —
// ~36 MB on /assets per Lighthouse "Improve image delivery"). The grid cell is
// `relative aspect-square`, so `fill` works; `sizes` tells the optimizer the
// real rendered width per breakpoint (grid is 2/3/4/5 cols, capped by max-w-6xl).
function ImageThumb({ url }: { url: string }) {
  if (canOptimize(url)) {
    return (
      <Image
        src={url}
        alt=""
        fill
        sizes="(max-width: 640px) 50vw, (max-width: 768px) 33vw, (max-width: 1024px) 25vw, 220px"
        quality={70}
        className="object-cover"
      />
    );
  }
  // External host not in remotePatterns → plain lazy <img> (no optimization).
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={url} alt="" className="w-full h-full object-cover" loading="lazy" decoding="async" />;
}

// <video preload="metadata"> has no native lazy equivalent: it fires a network
// request for the clip header the moment it mounts. Mounting hundreds at once
// floods the network and blocks the main thread (the TBT spike on /assets).
// This gate mounts the real <video> only once the card nears the viewport;
// until then it shows a cheap placeholder. Once shown, it stays mounted.
function LazyVideoThumb({ src }: { src: string }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [show, setShow] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setShow(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setShow(true);
          io.disconnect();
        }
      },
      { rootMargin: "300px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div ref={ref} className="w-full h-full">
      {show ? (
        <video
          src={src}
          className="w-full h-full object-cover"
          muted
          playsInline
          preload="metadata"
          onMouseEnter={(e) => { (e.currentTarget as HTMLVideoElement).play().catch(() => {}); }}
          onMouseLeave={(e) => { const v = e.currentTarget as HTMLVideoElement; v.pause(); v.currentTime = 0; }}
        />
      ) : (
        <div className="w-full h-full flex items-center justify-center bg-bg-card text-fg-subtle">
          <Video size={24} />
        </div>
      )}
    </div>
  );
}

function Lightbox({ asset, onClose, onDeleted }: { asset: AssetItem; onClose: () => void; onDeleted: () => void }) {
  const ek = effectiveKind(asset);
  const [deleting, setDeleting] = useState(false);
  const canDelete = asset.source === "generated" || asset.source === "upload";
  const doDelete = async () => {
    if (!window.confirm("Delete this asset permanently? It will be removed from the site.")) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/assets?id=${encodeURIComponent(asset.id)}`, { method: "DELETE" });
      if (res.ok) { onDeleted(); return; }
      window.alert("Delete failed.");
    } catch { window.alert("Delete failed."); }
    setDeleting(false);
  };
  return (
    <div
      className="fixed inset-0 z-[800] bg-black/70 backdrop-blur-md flex items-center justify-center p-6"
      onClick={onClose}
    >
      <div
        className="bg-bg-card border border-[rgb(var(--hairline)/var(--hairline-alpha))] rounded-[var(--radius-xl)] elev-3 overflow-hidden max-w-4xl w-full max-h-[88vh] flex flex-col md:flex-row"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Preview */}
        <div className="flex-1 bg-black flex items-center justify-center min-h-[300px] max-h-[88vh] overflow-hidden">
          {ek === "image" && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={asset.cdnUrl} alt="" className="max-w-full max-h-[88vh] object-contain" />
          )}
          {ek === "video" && (
            <video src={asset.cdnUrl} className="max-w-full max-h-[88vh]" controls autoPlay loop />
          )}
          {ek === "audio" && (
            <div className="p-8 w-full">
              <Music size={48} className="mx-auto mb-4 text-fg-subtle" />
              <audio src={asset.cdnUrl} controls className="w-full" />
            </div>
          )}
          {ek === "text" && (
            <div className="p-6 text-fg text-sm leading-relaxed overflow-auto max-h-[88vh]">{asset.prompt}</div>
          )}
        </div>

        {/* Meta panel */}
        <div className="w-full md:w-72 p-4 flex flex-col gap-3 border-t md:border-t-0 md:border-l border-[rgb(var(--hairline)/var(--hairline-alpha))]">
          <div className="flex items-center justify-between">
            <span className="font-mono text-[10px] uppercase tracking-wider text-brand">{ek} · {asset.source}</span>
            <button onClick={onClose} className="text-fg-subtle hover:text-fg"><X size={16} /></button>
          </div>

          {asset.prompt && (
            <div>
              <div className="text-[9px] uppercase tracking-wider text-fg-subtle mb-1">Prompt</div>
              <p className="text-[12px] text-fg-muted leading-snug max-h-40 overflow-auto">{asset.prompt}</p>
            </div>
          )}

          <div className="space-y-1.5 text-[11px]">
            <Meta label="Model" value={asset.model} />
            <Meta label="Project" value={asset.projectName} />
            <Meta label="Brand" value={asset.brandName} />
            <Meta label="Size" value={fmtSize(asset.sizeBytes)} />
            <Meta label="Dimensions" value={asset.width && asset.height ? `${asset.width}×${asset.height}` : null} />
            <Meta label="Duration" value={fmtDur(asset.durationSec)} />
            <Meta label="Created" value={new Date(asset.createdAt).toLocaleString()} />
          </div>

          <div className="mt-auto flex flex-col gap-2">
            <SaveToLibraryButton url={asset.cdnUrl} kind={asset.kind} label={asset.prompt || asset.model || undefined} />
            <a
              href={asset.cdnUrl}
              download
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-center gap-2 bg-brand text-white font-medium text-[12px] py-2 rounded-lg hover:opacity-90 transition"
            >
              <Download size={13} /> Download
            </a>
            {canDelete && (
              <button
                onClick={doDelete}
                disabled={deleting}
                className="flex items-center justify-center gap-2 border border-red-500/40 text-red-400 hover:bg-red-600 hover:text-white font-medium text-[12px] py-2 rounded-lg transition disabled:opacity-50"
              >
                {deleting ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />} Delete permanently
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <div className="flex justify-between gap-3">
      <span className="text-fg-subtle">{label}</span>
      <span className="text-fg-muted text-right truncate">{value}</span>
    </div>
  );
}
