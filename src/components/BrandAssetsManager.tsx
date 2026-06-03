"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { Loader2, Upload, X, Music, Video as VideoIcon } from "lucide-react";

type BrandAsset = { id: string; url: string; kind: string; category: string; label: string | null; embedStatus?: string | null };

const CATEGORIES: { value: string; label: string }[] = [
  { value: "logo", label: "Logo" },
  { value: "ui", label: "UI screenshot" },
  { value: "store", label: "Store screenshot" },
  { value: "graphic", label: "Graphic element" },
  { value: "overlay", label: "Overlay / plate" },
  { value: "music", label: "Music" },
  { value: "sound", label: "Sound FX" },
  { value: "reference", label: "Reference" },
  { value: "hook", label: "Hook" },
  { value: "body", label: "Body" },
  { value: "packshot", label: "Packshot" },
  { value: "other", label: "Other" },
];

function kindFromFile(file: File): string {
  if (file.type.startsWith("video")) return "video";
  if (file.type.startsWith("audio")) return "audio";
  return "image";
}

export default function BrandAssetsManager({ brandId }: { brandId: string }) {
  const [assets, setAssets] = useState<BrandAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [category, setCategory] = useState("logo");
  const [filter, setFilter] = useState("all");
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/brand-assets?brandId=${brandId}`);
      const data = await res.json();
      setAssets(data.assets ?? []);
    } catch {
      setAssets([]);
    } finally {
      setLoading(false);
    }
  }, [brandId]);

  useEffect(() => { load(); }, [load]);

  // While any video embed is still processing, re-poll so the badge flips to
  // "searchable" without a manual refresh (GET finishes embeds server-side).
  useEffect(() => {
    const stillEmbedding = assets.some((a) => a.kind === "video" && a.embedStatus === "processing");
    if (!stillEmbedding) return;
    const t = setInterval(() => { load(); }, 12000);
    return () => clearInterval(t);
  }, [assets, load]);

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        const fd = new FormData();
        fd.append("file", file);
        const up = await fetch("/api/upload", { method: "POST", body: fd });
        if (!up.ok) continue;
        const { cdnUrl } = await up.json();
        if (!cdnUrl) continue;
        await fetch("/api/brand-assets", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ brandId, url: cdnUrl, kind: kindFromFile(file), category, label: file.name }),
        });
      }
      await load();
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  async function remove(id: string) {
    setAssets((prev) => prev.filter((a) => a.id !== id));
    await fetch(`/api/brand-assets?id=${id}`, { method: "DELETE" });
  }

  const visible = filter === "all" ? assets : assets.filter((a) => a.category === filter);
  const usedCategories = ["all", ...CATEGORIES.map((c) => c.value).filter((c) => assets.some((a) => a.category === c))];

  return (
    <div className="space-y-3">
      {/* Upload row */}
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          className="bg-bg border border-border rounded-md px-2.5 py-2 text-[12px] text-fg"
        >
          {CATEGORIES.map((c) => (
            <option key={c.value} value={c.value}>{c.label}</option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => fileInput.current?.click()}
          disabled={uploading}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md border border-brand text-brand text-[12px] hover:bg-brand/10 transition disabled:opacity-60"
        >
          {uploading ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
          {uploading ? "Uploading…" : "Upload to this category"}
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="image/*,video/*,audio/*"
          multiple
          className="hidden"
          onChange={(e) => handleFiles(e.target.files)}
        />
        <span className="text-[10px] text-fg-subtle">Images, video, audio.</span>
      </div>

      {/* Category filter */}
      {usedCategories.length > 1 && (
        <div className="flex flex-wrap gap-1">
          {usedCategories.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setFilter(c)}
              className={`px-2 py-0.5 rounded-full text-[10px] border transition ${
                filter === c ? "bg-brand/15 border-brand text-brand" : "border-border text-fg-muted hover:text-fg"
              }`}
            >
              {c === "all" ? "All" : CATEGORIES.find((x) => x.value === c)?.label ?? c}
            </button>
          ))}
        </div>
      )}

      {/* Grid */}
      {loading ? (
        <div className="flex items-center justify-center py-8 text-fg-subtle"><Loader2 size={16} className="animate-spin" /></div>
      ) : visible.length === 0 ? (
        <p className="text-[11px] text-fg-subtle py-6 text-center border border-dashed border-border rounded-md">
          No brand assets yet. Pick a category and upload.
        </p>
      ) : (
        <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
          {visible.map((a) => (
            <div key={a.id} className="relative group aspect-square rounded-md overflow-hidden border border-border bg-bg">
              {a.kind === "image" && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={a.url} alt="" className="w-full h-full object-cover" />
              )}
              {a.kind === "video" && (
                <div className="w-full h-full flex items-center justify-center bg-black">
                  <video src={a.url} className="w-full h-full object-cover" muted preload="metadata" />
                  <VideoIcon size={16} className="absolute text-white/80" />
                </div>
              )}
              {a.kind === "audio" && (
                <div className="w-full h-full flex items-center justify-center"><Music size={20} className="text-fg-subtle" /></div>
              )}
              <span className="absolute top-1 left-1 px-1 py-0.5 rounded bg-black/55 text-[7px] uppercase text-white/85">
                {a.category}
              </span>
              {a.embedStatus && a.kind !== "audio" && (
                <span
                  className={`absolute bottom-1 left-1 px-1 py-0.5 rounded text-[7px] uppercase ${
                    a.embedStatus === "ready"
                      ? "bg-emerald-600/80 text-white"
                      : a.embedStatus === "failed"
                        ? "bg-red-600/80 text-white"
                        : "bg-amber-500/80 text-black"
                  }`}
                  title="Semantic search index"
                >
                  {a.embedStatus === "ready" ? "searchable" : a.embedStatus === "failed" ? "index failed" : "indexing…"}
                </span>
              )}
              <button
                type="button"
                onClick={() => remove(a.id)}
                className="absolute top-1 right-1 w-5 h-5 rounded bg-black/55 text-white/85 opacity-0 group-hover:opacity-100 flex items-center justify-center hover:bg-red-500/80 transition"
              >
                <X size={11} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
