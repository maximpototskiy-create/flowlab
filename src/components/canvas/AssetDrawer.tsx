"use client";

import { useEffect, useState, useCallback } from "react";
import { Search, X, Image as ImageIcon, Video, Music, Loader2 } from "lucide-react";
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

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // Don't filter by kind on the server — load once and filter tabs
      // locally so switching tabs is instant and fal's own `type` is the
      // source of truth (the server media_type filter was returning empty).
      const p = new URLSearchParams();
      if (debouncedQ) p.set("q", debouncedQ);
      const endpoint = source === "fal" ? "/api/fal-assets" : "/api/assets";
      const res = await fetch(`${endpoint}?${p.toString()}`);
      const data = await res.json();
      setAssets(data.assets ?? []);
    } catch {
      setAssets([]);
    } finally {
      setLoading(false);
    }
  }, [debouncedQ, source]);

  useEffect(() => { load(); }, [load]);

  // Tab filter is purely local now → instant switching, no refetch.
  const visible = kind ? assets.filter((a) => a.kind === kind) : assets;

  return (
    <div
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

      {/* Grid */}
      <div className="flex-1 overflow-auto p-3" onWheel={(e) => e.stopPropagation()}>
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
                onClick={() => onPick(a)}
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
      </div>

      <div className="px-3 py-2 border-t border-border text-[10px] text-fg-subtle">
        Drag onto canvas or click to add a node.
      </div>
    </div>
  );
}
