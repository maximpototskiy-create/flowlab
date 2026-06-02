"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { Search, X, Image as ImageIcon, Video, Music, Loader2, Plus, Download, Sparkles } from "lucide-react";
import type { AssetItem } from "@/lib/assetsQuery";

const KINDS = [
  { value: "", label: "All" },
  { value: "image", label: "Img", icon: ImageIcon },
  { value: "video", label: "Vid", icon: Video },
  { value: "audio", label: "Aud", icon: Music },
];

// Asset library as a slide-in drawer on the canvas. Cards are draggable onto
// the canvas (drop = create an upload node wired to that asset) and clickable
// (click = add the node at viewport center via onPick).
export default function AssetDrawer({
  onClose,
  onPick,
}: {
  onClose: () => void;
  onPick: (asset: AssetItem) => void;
}) {
  const [assets, setAssets] = useState<AssetItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [source, setSource] = useState<"flowlab" | "fal">("flowlab");
  const [kind, setKind] = useState("");
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [preview, setPreview] = useState<AssetItem | null>(null);
  // "Find similar" mode: search fal by a reference media URL.
  const [similar, setSimilar] = useState<{ url: string; kind: string; label: string } | null>(null);
  const [limit, setLimit] = useState(60);
  const [hasMore, setHasMore] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const p = new URLSearchParams();
      if (debouncedQ) p.set("q", debouncedQ);
      p.set("limit", String(limit));
      if (source === "fal" && similar) {
        p.set(similar.kind === "video" ? "search_video_url" : "search_image_url", similar.url);
      }
      const endpoint = source === "fal" ? "/api/fal-assets" : "/api/assets";
      const res = await fetch(`${endpoint}?${p.toString()}`);
      const data = await res.json();
      const list: AssetItem[] = data.assets ?? [];
      setAssets(list);
      // fal returns has_more; FlowLab: assume more if we filled the page.
      setHasMore(source === "fal" ? !!data.has_more : list.length >= limit);
    } catch {
      setAssets([]);
      setHasMore(false);
    } finally {
      setLoading(false);
    }
  }, [debouncedQ, source, similar, limit]);

  useEffect(() => { load(); }, [load]);

  // Reset the page size whenever the query scope changes.
  useEffect(() => { setLimit(60); }, [source, debouncedQ, similar]);

  // Tab filter is purely local now → instant switching, no refetch.
  const visible = kind ? assets.filter((a) => a.kind === kind) : assets;

  // Stop wheel from reaching the canvas. The canvas binds a NATIVE wheel
  // listener on its own element, which fires on bubble BEFORE React's
  // delegated onWheel — so React stopPropagation doesn't help. We bind a
  // native listener on the drawer root and stop propagation there, before
  // the event bubbles up to the canvas element.
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const stop = (e: WheelEvent) => e.stopPropagation();
    el.addEventListener("wheel", stop, { passive: true });
    return () => el.removeEventListener("wheel", stop);
  }, []);

  return (
    <div
      ref={rootRef}
      className="absolute top-0 right-0 h-full w-[340px] z-30 bg-bg-card border-l border-border shadow-panel flex flex-col"
      onPointerDown={(e) => e.stopPropagation()}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 h-12 border-b border-border">
        <span className="text-[12px] font-semibold text-fg">Asset library</span>
        <button onClick={onClose} className="text-fg-subtle hover:text-fg"><X size={16} /></button>
      </div>

      {/* Filters */}
      <div className="p-3 space-y-2 border-b border-border">
        {/* Source switch */}
        <div className="flex gap-1">
          <button
            onClick={() => setSource("flowlab")}
            className={`flex-1 px-2 py-1 rounded text-[10px] border transition ${
              source === "flowlab" ? "bg-brand/15 border-brand text-brand" : "border-border text-fg-muted hover:text-fg"
            }`}
          >
            FlowLab
          </button>
          <button
            onClick={() => setSource("fal")}
            className={`flex-1 px-2 py-1 rounded text-[10px] border transition ${
              source === "fal" ? "bg-brand/15 border-brand text-brand" : "border-border text-fg-muted hover:text-fg"
            }`}
          >
            fal
          </button>
        </div>
        <div className="relative">
          <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-subtle" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={source === "fal" ? "Semantic search…" : "Search…"}
            className="w-full bg-bg border border-border rounded-md pl-7 pr-2 py-1.5 text-[11px] text-fg outline-none focus:border-brand"
          />
        </div>
        <div className="flex gap-1">
          {KINDS.map((k) => (
            <button
              key={k.value}
              onClick={() => setKind(k.value)}
              className={`flex-1 px-2 py-1 rounded text-[10px] border transition ${
                kind === k.value ? "bg-brand/15 border-brand text-brand" : "border-border text-fg-muted hover:text-fg"
              }`}
            >
              {k.label}
            </button>
          ))}
        </div>
      </div>

      {/* Similar-search banner */}
      {source === "fal" && similar && (
        <div className="px-3 py-2 border-b border-border flex items-center gap-2 bg-brand/10">
          {similar.kind === "video" ? (
            <video src={similar.url} className="w-7 h-7 rounded object-cover" muted preload="metadata" />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={similar.url} alt="" className="w-7 h-7 rounded object-cover" />
          )}
          <span className="text-[10px] text-fg-muted flex-1">Similar to this {similar.kind}</span>
          <button onClick={() => setSimilar(null)} className="text-fg-subtle hover:text-fg">
            <X size={13} />
          </button>
        </div>
      )}

      {/* Grid */}
      <div className="flex-1 overflow-auto p-3">
        {loading ? (
          <div className="flex items-center justify-center py-12 text-fg-subtle">
            <Loader2 size={18} className="animate-spin" />
          </div>
        ) : visible.length === 0 ? (
          <p className="text-center text-fg-subtle text-[11px] py-12">No assets.</p>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {visible.map((a) => (
              <div
                key={a.id}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData(
                    "application/x-flowlab-asset",
                    JSON.stringify({ cdnUrl: a.cdnUrl, kind: a.kind }),
                  );
                  e.dataTransfer.effectAllowed = "copy";
                }}
                onClick={() => setPreview(a)}
                title={a.prompt || a.model || a.kind}
                className="group relative aspect-square rounded-md overflow-hidden bg-bg border border-border hover:border-brand cursor-grab active:cursor-grabbing"
              >
                {a.kind === "image" && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={a.cdnUrl} alt="" className="w-full h-full object-cover pointer-events-none" loading="lazy" />
                )}
                {a.kind === "video" && (
                  <video src={a.cdnUrl} className="w-full h-full object-cover pointer-events-none" muted preload="metadata" />
                )}
                {a.kind === "audio" && (
                  <div className="w-full h-full flex items-center justify-center text-fg-subtle"><Music size={20} /></div>
                )}
                {a.kind === "text" && (
                  <div className="w-full h-full flex items-center justify-center p-2 text-fg-muted text-[8px] overflow-hidden">
                    {a.prompt?.slice(0, 80)}
                  </div>
                )}
                <span className="absolute top-1 left-1 px-1 py-0.5 rounded bg-black/50 text-[7px] uppercase text-white/80">
                  {a.kind}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* Load more — only when not filtering tabs locally to a subset */}
        {!loading && hasMore && (!kind || visible.length >= 4) && (
          <button
            onClick={() => setLimit((n) => n + 60)}
            className="w-full mt-3 py-2 rounded-md border border-border text-fg-muted hover:text-fg hover:border-border-strong text-[11px] transition"
          >
            Load more
          </button>
        )}
      </div>

      <div className="px-3 py-2 border-t border-border text-[10px] text-fg-subtle">
        Drag onto canvas, or click to preview.
      </div>

      {/* Preview overlay — inside the drawer */}
      {preview && (
        <div className="absolute inset-0 z-10 bg-bg-card flex flex-col">
          <div className="flex items-center justify-between px-3 h-12 border-b border-border">
            <span className="font-mono text-[10px] uppercase tracking-wider text-brand">
              {preview.kind} · {preview.source}
            </span>
            <button onClick={() => setPreview(null)} className="text-fg-subtle hover:text-fg">
              <X size={16} />
            </button>
          </div>

          {/* Media */}
          <div className="bg-black flex items-center justify-center" style={{ maxHeight: "45%" }}>
            {preview.kind === "image" && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={preview.cdnUrl} alt="" className="max-w-full max-h-[45vh] object-contain" />
            )}
            {preview.kind === "video" && (
              <video src={preview.cdnUrl} className="max-w-full max-h-[45vh]" controls autoPlay loop />
            )}
            {preview.kind === "audio" && (
              <div className="p-6 w-full">
                <Music size={36} className="mx-auto mb-3 text-fg-subtle" />
                <audio src={preview.cdnUrl} controls className="w-full" />
              </div>
            )}
            {preview.kind === "text" && (
              <div className="p-4 text-fg text-[12px] leading-relaxed overflow-auto max-h-[45vh]">
                {preview.prompt}
              </div>
            )}
          </div>

          {/* Meta */}
          <div className="flex-1 overflow-auto p-3 space-y-3">
            {preview.prompt && (
              <div>
                <div className="text-[9px] uppercase tracking-wider text-fg-subtle mb-1">Prompt</div>
                <p className="text-[12px] text-fg-muted leading-snug">{preview.prompt}</p>
              </div>
            )}
            <div className="space-y-1.5 text-[11px]">
              {preview.model && (
                <div className="flex justify-between gap-3">
                  <span className="text-fg-subtle">Model</span>
                  <span className="text-fg-muted text-right truncate">{preview.model}</span>
                </div>
              )}
              {preview.width && preview.height && (
                <div className="flex justify-between gap-3">
                  <span className="text-fg-subtle">Size</span>
                  <span className="text-fg-muted">{preview.width}×{preview.height}</span>
                </div>
              )}
              {preview.projectName && (
                <div className="flex justify-between gap-3">
                  <span className="text-fg-subtle">Project</span>
                  <span className="text-fg-muted text-right truncate">{preview.projectName}</span>
                </div>
              )}
              {preview.brandName && (
                <div className="flex justify-between gap-3">
                  <span className="text-fg-subtle">Brand</span>
                  <span className="text-fg-muted text-right truncate">{preview.brandName}</span>
                </div>
              )}
            </div>
          </div>

          {/* Actions */}
          <div className="p-3 border-t border-border flex gap-2">
            <button
              onClick={() => { onPick(preview); setPreview(null); }}
              className="flex-1 flex items-center justify-center gap-1.5 bg-brand text-black font-medium text-[12px] py-2 rounded-md hover:bg-emerald-400 transition"
            >
              <Plus size={13} /> Add to canvas
            </button>
            {preview.source === "fal" && (preview.kind === "image" || preview.kind === "video") && (
              <button
                onClick={() => {
                  setSimilar({ url: preview.cdnUrl, kind: preview.kind, label: preview.prompt || preview.kind });
                  setQ("");
                  setPreview(null);
                }}
                title="Find visually similar"
                className="flex items-center justify-center gap-1.5 border border-border text-fg-muted hover:text-fg text-[12px] px-3 py-2 rounded-md transition"
              >
                <Sparkles size={13} />
              </button>
            )}
            <a
              href={preview.cdnUrl}
              download
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-center gap-1.5 border border-border text-fg-muted hover:text-fg text-[12px] px-3 py-2 rounded-md transition"
            >
              <Download size={13} />
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
