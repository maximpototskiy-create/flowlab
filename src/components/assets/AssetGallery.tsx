"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Search, Download, X, Image as ImageIcon, Video, Music, FileText } from "lucide-react";
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

  // ── Client-side windowing (infinite scroll) ──
  // Render `visible` cards; a sentinel below the grid bumps it by PAGE when it
  // scrolls into view. Reset whenever the asset set changes (new filter).
  const [visible, setVisible] = useState(PAGE);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setVisible(PAGE);
  }, [assets]);

  useEffect(() => {
    if (visible >= assets.length) return;
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible((v) => Math.min(v + PAGE, assets.length));
        }
      },
      { rootMargin: "800px" }, // start loading the next page well before it's on screen
    );
    io.observe(el);
    return () => io.disconnect();
  }, [assets.length, visible]);

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
  const shown = assets.slice(0, visible);

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
            className="bg-bg-card border border-border rounded-md pl-8 pr-3 py-1.5 text-[12px] text-fg w-56 outline-none focus:border-brand"
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
          className="bg-bg-card border border-border rounded-md px-2 py-1.5 text-[11px] text-fg-muted outline-none focus:border-brand"
        >
          <option value="">All projects</option>
          {projects.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
        </select>
        <select
          value={active.brand ?? ""}
          onChange={(e) => setFilter("brand", e.target.value || null)}
          className="bg-bg-card border border-border rounded-md px-2 py-1.5 text-[11px] text-fg-muted outline-none focus:border-brand"
        >
          <option value="">All brands</option>
          {brands.map((b) => <option key={b.value} value={b.value}>{b.label}</option>)}
        </select>
        <select
          value={active.sort ?? "newest"}
          onChange={(e) => setFilter("sort", e.target.value === "newest" ? null : e.target.value)}
          className="bg-bg-card border border-border rounded-md px-2 py-1.5 text-[11px] text-fg-muted outline-none focus:border-brand"
          title="Sort by date"
        >
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
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
        <div className="bg-bg border border-dashed border-border-strong rounded-sm py-20 text-center">
          <h3 className="font-display text-3xl mb-2">Nothing here yet.</h3>
          <p className="text-fg-muted text-sm">Generate or upload assets and they'll show up here.</p>
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
                className="group relative aspect-square rounded-lg overflow-hidden bg-bg-card border border-border hover:border-brand transition text-left"
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
          {visible < assets.length && (
            <div ref={sentinelRef} className="py-8 text-center text-fg-subtle text-[11px]">
              Loading more… ({visible} / {assets.length})
            </div>
          )}
        </>
      )}

      {/* ── Lightbox ── */}
      {lightbox && <Lightbox asset={lightbox} onClose={() => setLightbox(null)} />}
    </div>
  );
}

function AssetThumb({ asset, ek }: { asset: AssetItem; ek: string }) {
  if (ek === "image") {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={asset.cdnUrl} alt="" className="w-full h-full object-cover" loading="lazy" decoding="async" />;
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

function Lightbox({ asset, onClose }: { asset: AssetItem; onClose: () => void }) {
  const ek = effectiveKind(asset);
  return (
    <div
      className="fixed inset-0 z-[800] bg-black/80 backdrop-blur-sm flex items-center justify-center p-6"
      onClick={onClose}
    >
      <div
        className="bg-bg-card border border-border rounded-xl overflow-hidden max-w-4xl w-full max-h-[88vh] flex flex-col md:flex-row"
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
        <div className="w-full md:w-72 p-4 flex flex-col gap-3 border-t md:border-t-0 md:border-l border-border">
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
              className="flex items-center justify-center gap-2 bg-brand text-black font-medium text-[12px] py-2 rounded-md hover:bg-emerald-400 transition"
            >
              <Download size={13} /> Download
            </a>
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
