"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { Loader2, Search, ImagePlus, X, Type, Music } from "lucide-react";

type Moment = { startSec: number | null; endSec: number | null; similarity: number };
type AssetResult = {
  assetId: string | null;
  url: string;
  modality: string;
  category: string | null;
  brandId: string | null;
  similarity: number;
  moments: Moment[];
  matches: number;
};

const CATEGORIES = ["logo", "ui", "store", "graphic", "overlay", "music", "sound", "reference", "hook", "body", "packshot", "other"];

function fmt(sec: number | null): string {
  if (sec == null) return "";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function LibraryView() {
  const [mode, setMode] = useState<"text" | "image">("text");
  const [query, setQuery] = useState("");
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [uploadingImg, setUploadingImg] = useState(false);
  const [modality, setModality] = useState<"all" | "image" | "video">("all");
  const [category, setCategory] = useState<string>("all");
  const [sort, setSort] = useState<"newest" | "oldest" | "type">("newest");
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<AssetResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<AssetResult | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  async function uploadQueryImage(files: FileList | null) {
    if (!files?.[0]) return;
    setUploadingImg(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append("file", files[0]);
      const res = await fetch("/api/upload", { method: "POST", body: fd });
      const data = await res.json();
      if (data.cdnUrl) setImageUrl(data.cdnUrl);
      else setError("Upload failed");
    } catch {
      setError("Upload failed");
    } finally {
      setUploadingImg(false);
    }
  }

  async function run() {
    if (mode === "text" && !query.trim()) return;
    if (mode === "image" && !imageUrl) return;
    setLoading(true);
    setError(null);
    setResults(null);
    try {
      const res = await fetch("/api/semantic-search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: mode === "text" ? query : undefined,
          imageUrl: mode === "image" ? imageUrl : undefined,
          modality: modality === "all" ? undefined : modality,
          category: category === "all" ? undefined : category,
        }),
      });
      const data = await res.json();
      if (data.error) setError(data.error);
      else setResults(data.results ?? []);
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  }

  // Browse mode: no search query — just list assets by category/type, newest first.
  const browse = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const p = new URLSearchParams();
      if (category !== "all") p.set("category", category);
      if (modality !== "all") p.set("modality", modality);
      p.set("sort", sort);
      p.set("limit", "60");
      const res = await fetch(`/api/brand-assets/browse?${p.toString()}`);
      const data = await res.json();
      const rows: Array<{ url: string; kind: string; category: string | null }> = data.assets ?? [];
      setResults(
        rows.map((r) => ({
          assetId: r.url,
          url: r.url,
          modality: r.kind === "audio" ? "audio" : r.kind === "video" ? "video" : "image",
          category: r.category,
          brandId: null,
          similarity: 1,
          moments: [],
          matches: 0,
        })),
      );
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  }, [category, modality, sort]);

  // No active search → browse mode. Loads on mount and whenever a filter or
  // sort changes, even for "All" (shows everything, newest first by default).
  useEffect(() => {
    const hasQuery = (mode === "text" && query.trim()) || (mode === "image" && imageUrl);
    if (!hasQuery) browse();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [category, modality, sort]);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold text-fg">Library</h1>
        <p className="text-[12px] text-fg-muted mt-0.5">
          Search your assets by text or image — or pick a category below to browse without searching.
        </p>
      </div>

      {/* Mode toggle */}
      <div className="flex gap-1">
        <button
          onClick={() => setMode("text")}
          className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12px] border transition ${
            mode === "text" ? "bg-brand/15 border-brand text-brand" : "border-border text-fg-muted hover:text-fg"
          }`}
        >
          <Type size={13} /> Text
        </button>
        <button
          onClick={() => setMode("image")}
          className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12px] border transition ${
            mode === "image" ? "bg-brand/15 border-brand text-brand" : "border-border text-fg-muted hover:text-fg"
          }`}
        >
          <ImagePlus size={13} /> Image
        </button>
      </div>

      {/* Query input */}
      {mode === "text" ? (
        <div className="flex gap-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && run()}
            placeholder="e.g. phone with green screen in hand, upbeat"
            className="flex-1 bg-bg border border-border rounded-md p-2.5 text-[13px] text-fg outline-none focus:border-brand"
          />
          <button
            onClick={run}
            disabled={loading || !query.trim()}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-brand text-black font-medium text-[12px] disabled:opacity-60"
          >
            {loading ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
            Search
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-3">
          {imageUrl ? (
            <div className="relative">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={imageUrl} alt="" className="w-20 h-20 object-cover rounded-md border border-border" />
              <button onClick={() => setImageUrl(null)} className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-bg-card border border-border flex items-center justify-center text-fg-muted">
                <X size={11} />
              </button>
            </div>
          ) : (
            <button
              onClick={() => fileInput.current?.click()}
              disabled={uploadingImg}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md border border-brand text-brand text-[12px] hover:bg-brand/10 disabled:opacity-60"
            >
              {uploadingImg ? <Loader2 size={13} className="animate-spin" /> : <ImagePlus size={13} />}
              {uploadingImg ? "Uploading…" : "Upload an image"}
            </button>
          )}
          <input ref={fileInput} type="file" accept="image/*" className="hidden" onChange={(e) => uploadQueryImage(e.target.files)} />
          <button
            onClick={run}
            disabled={loading || !imageUrl}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-brand text-black font-medium text-[12px] disabled:opacity-60"
          >
            {loading ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
            Find similar
          </button>
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1">
          {(["all", "image", "video"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setModality(m)}
              className={`px-2 py-0.5 rounded-full text-[10px] border transition ${
                modality === m ? "bg-brand/15 border-brand text-brand" : "border-border text-fg-muted hover:text-fg"
              }`}
            >
              {m === "all" ? "All types" : m}
            </button>
          ))}
        </div>
        <span className="text-fg-subtle text-[10px]">·</span>
        <div className="flex flex-wrap gap-1">
          <button
            onClick={() => setCategory("all")}
            className={`px-2 py-0.5 rounded-full text-[10px] border transition ${
              category === "all" ? "bg-brand/15 border-brand text-brand" : "border-border text-fg-muted hover:text-fg"
            }`}
          >
            All
          </button>
          {CATEGORIES.map((c) => (
            <button
              key={c}
              onClick={() => setCategory(c)}
              className={`px-2 py-0.5 rounded-full text-[10px] border transition ${
                category === c ? "bg-brand/15 border-brand text-brand" : "border-border text-fg-muted hover:text-fg"
              }`}
            >
              {c}
            </button>
          ))}
        </div>
        <span className="text-fg-subtle text-[10px]">·</span>
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as "newest" | "oldest" | "type")}
          className="bg-bg border border-border rounded-md px-2 py-0.5 text-[10px] text-fg-muted outline-none focus:border-brand"
          title="Sort (applies when browsing, not searching)"
        >
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
          <option value="type">By type</option>
        </select>
      </div>
      {error && <p className="text-[12px] text-red-400">{error}</p>}
      {loading && <p className="text-[11px] text-fg-subtle">Searching…</p>}

      {results && (
        <div className="space-y-2">
          <div className="text-[11px] text-fg-muted">{results.length} result{results.length === 1 ? "" : "s"}</div>
          {results.length === 0 ? (
            <p className="text-[12px] text-fg-subtle py-6 text-center border border-dashed border-border rounded-md">
              Nothing matched. Try different wording or another image.
            </p>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
              {results.map((r, i) => (
                <button
                  key={`${r.assetId ?? r.url}-${i}`}
                  onClick={() => setOpen(r)}
                  className="text-left rounded-md overflow-hidden border border-border bg-bg-card hover:border-brand transition"
                >
                  <div className="aspect-square bg-black flex items-center justify-center">
                    {r.modality === "image" ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={r.url} alt="" className="w-full h-full object-cover" loading="lazy" />
                    ) : r.modality === "audio" ? (
                      <Music size={28} className="text-fg-subtle" />
                    ) : (
                      // eslint-disable-next-line jsx-a11y/media-has-caption
                      <video src={r.url} className="w-full h-full object-cover" muted preload="metadata" />
                    )}
                  </div>
                  <div className="p-2 space-y-0.5">
                    <div className="flex items-center justify-between text-[10px]">
                      <span className="text-brand font-medium">{Math.round(r.similarity * 100)}%</span>
                      <span className="text-fg-subtle uppercase">{r.category ?? r.modality}</span>
                    </div>
                    {r.modality === "video" && r.moments[0] && (
                      <div className="text-[9px] text-fg-subtle">
                        best {fmt(r.moments[0].startSec)}–{fmt(r.moments[0].endSec)} · {r.matches} clip{r.matches === 1 ? "" : "s"}
                      </div>
                    )}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {open && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onClick={() => setOpen(null)}>
          <div className="bg-bg-card rounded-lg overflow-hidden max-w-2xl w-full" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between p-3 border-b border-border">
              <span className="text-[12px] text-fg uppercase">{open.category ?? open.modality} · {Math.round(open.similarity * 100)}%</span>
              <button onClick={() => setOpen(null)} className="text-fg-subtle hover:text-fg"><X size={16} /></button>
            </div>
            <div className="bg-black flex items-center justify-center max-h-[60vh]">
              {open.modality === "image" ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={open.url} alt="" className="max-h-[60vh] w-auto object-contain" />
              ) : open.modality === "audio" ? (
                <div className="w-full p-8 flex flex-col items-center gap-4">
                  <Music size={48} className="text-fg-subtle" />
                  {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                  <audio src={open.url} controls autoPlay className="w-full" />
                </div>
              ) : (
                // eslint-disable-next-line jsx-a11y/media-has-caption
                <video src={open.url} controls autoPlay className="max-h-[60vh] w-auto" />
              )}
            </div>
            {open.modality === "video" && open.moments.length > 0 && (
              <div className="p-3 text-[11px] text-fg-muted">
                Matching moments: {open.moments.map((m) => `${fmt(m.startSec)}–${fmt(m.endSec)}`).join(", ")}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
