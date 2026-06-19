"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { Search, X, Image as ImageIcon, Video, Music, Loader2, Plus, Download, Sparkles, Play, Pause, Trash2, RefreshCw, Cloud } from "lucide-react";
import type { AssetItem } from "@/lib/assetsQuery";
import SaveToLibraryButton from "@/components/SaveToLibraryButton";

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
  brandId,
}: {
  onClose: () => void;
  onPick: (asset: AssetItem) => void;
  brandId?: string | null;
}) {
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
  const [assets, setAssets] = useState<AssetItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [source, setSource] = useState<"library" | "generated" | "ui">("generated");
  const [genSource, setGenSource] = useState<"projects" | "fal">("projects");
  const [libCategory, setLibCategory] = useState<string>("all");
  const [libSub, setLibSub] = useState<string>("all");
  const [subByUrl, setSubByUrl] = useState<Record<string, string>>({});
  // brand selector — defaults to the workflow's brand, but any brand can be browsed
  const [brandSel, setBrandSel] = useState<string>(brandId ?? "");
  const [brandOpts, setBrandOpts] = useState<{ value: string; label: string }[]>([]);
  useEffect(() => {
    (async () => {
      try { const r = await fetch("/api/assets?limit=1"); const j = await r.json(); if (Array.isArray(j.brands)) setBrandOpts(j.brands); } catch { /* */ }
    })();
  }, []);
  const isFal = source === "generated" && genSource === "fal";
  const [kind, setKind] = useState("");
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [preview, setPreview] = useState<AssetItem | null>(null);
  // "Find similar" mode: search fal by a reference media URL.
  const [similar, setSimilar] = useState<{ url: string; kind: string; label: string } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [limit, setLimit] = useState(60);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  // fal taxonomy: tags + characters, and the active filter selection.
  const [tags, setTags] = useState<{ id: string; name: string }[]>([]);
  const [characters, setCharacters] = useState<{ id: string; name: string; identifier: string | null; cover: string | null }[]>([]);
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [activeChar, setActiveChar] = useState<string | null>(null);

  // Load tags + characters once we're on the fal source.
  useEffect(() => {
    if (!isFal) return;
    let alive = true;
    (async () => {
      try {
        const res = await fetch("/api/fal-taxonomy");
        const data = await res.json();
        if (!alive) return;
        setTags(data.tags ?? []);
        setCharacters(data.characters ?? []);
      } catch {
        /* ignore */
      }
    })();
    return () => { alive = false; };
  }, [source, brandSel]);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  // Fetch up to `targetLimit` items. When append=true we keep the already
  // rendered items and only add the new tail — so React reuses existing DOM
  // (by key) and the scroll position is preserved.
  const loadPage = useCallback(async (targetLimit: number, append: boolean) => {
    if (append) setLoadingMore(true); else setLoading(true);
    try {
      // Library = semantic search over THIS brand's curated assets (pgvector).
      if (source === "library") {
        const hasQuery = !!debouncedQ || !!(similar && similar.url);
        if (!hasQuery) {
          // No search query → browse mode: list this brand's assets, optionally
          // filtered by the selected category, newest first.
          const bp = new URLSearchParams();
          if (brandSel) bp.set("brandId", brandSel);
          if (libCategory !== "all") bp.set("category", libCategory);
          bp.set("limit", String(targetLimit));
          const bres = await fetch(`/api/brand-assets/browse?${bp.toString()}`);
          const bdata = await bres.json();
          const brows: Array<{ url: string; kind: string; category: string | null; subpath?: string | null; label?: string | null }> = bdata.assets ?? [];
          const sm: Record<string, string> = {};
          for (const r of brows) if (r.subpath) sm[r.url] = r.subpath.split("/")[0];
          setSubByUrl(sm);
          const libAssets: AssetItem[] = brows.map((r, i) => ({
            id: `lib-b-${i}-${r.url}`,
            cdnUrl: r.url,
            kind: r.kind === "audio" ? "audio" : r.kind === "video" ? "video" : "image",
            mimeType: null,
            sizeBytes: null,
            width: null,
            height: null,
            durationSec: null,
            source: "library",
            model: null,
            prompt: r.label || r.category,
            createdAt: new Date().toISOString(),
            projectName: null,
            brandName: null,
          }));
          // Fold brand-kit UI screenshots INTO Library (no separate tab). Only in
          // the unfiltered "all" view; guarded so a failure never breaks Library.
          let uiAssets: AssetItem[] = [];
          if (libCategory === "all") {
            try {
              const up = new URLSearchParams();
              up.set("source", "brand_kit");
              if (brandSel) up.set("brand", brandSel);
              up.set("limit", String(targetLimit));
              const ures = await fetch(`/api/assets?${up.toString()}`);
              const udata = await ures.json();
              uiAssets = ((udata.assets ?? []) as AssetItem[]).map((a) => ({ ...a, source: a.source || "brand_kit" }));
            } catch { /* curated only on failure */ }
          }
          setAssets([...libAssets, ...uiAssets]);
          setHasMore(false);
          return;
        }
        const res = await fetch("/api/semantic-search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            query: similar?.url ? undefined : debouncedQ,
            imageUrl: similar?.url,
            brandId: brandSel || undefined,
            category: libCategory === "all" ? undefined : libCategory,
            limit: targetLimit,
          }),
        });
        const data = await res.json();
        const results: Array<{ url: string; modality: string; category: string | null; similarity: number }> = data.results ?? [];
        const list: AssetItem[] = results.map((r, i) => ({
          id: `lib-${i}-${r.url}`,
          cdnUrl: r.url,
          kind: r.modality === "audio" ? "audio" : r.modality === "video" ? "video" : "image",
          mimeType: null,
          sizeBytes: null,
          width: null,
          height: null,
          durationSec: null,
          source: "library",
          model: null,
          prompt: r.category ? `${r.category} · ${Math.round(r.similarity * 100)}%` : null,
          createdAt: new Date().toISOString(),
          projectName: null,
          brandName: null,
        }));
        setAssets(list);
        setHasMore(false);
        return;
      }

      const p = new URLSearchParams();
      if (debouncedQ) p.set("q", debouncedQ);
      p.set("limit", String(targetLimit));
      if (isFal && similar) {
        p.set(similar.kind === "video" ? "search_video_url" : "search_image_url", similar.url);
      }
      if (isFal && activeTag) p.set("tag_id", activeTag);
      if (isFal && activeChar) p.set("character_identifier", activeChar);
      // UI = brand-kit screenshots for the current brand.
      if (source === "ui") {
        p.set("source", "brand_kit");
        if (brandSel) p.set("brand", brandSel);
      }
      if (source === "generated" && !isFal) {
        // Only TRUE generations here — exclude uploads / UI-added / brand-kit.
        p.set("source", "generated");
        if (brandSel) p.set("brand", brandSel);
      }
      const endpoint = isFal ? "/api/fal-assets" : "/api/assets";
      const res = await fetch(`${endpoint}?${p.toString()}`);
      const data = await res.json();
      const list: AssetItem[] = data.assets ?? [];
      setAssets((prev) => (append ? [...prev, ...list.slice(prev.length)] : list));
      setHasMore(isFal ? !!data.has_more : list.length >= targetLimit);
    } catch {
      if (!append) setAssets([]);
      setHasMore(false);
    } finally {
      if (append) setLoadingMore(false); else setLoading(false);
    }
  }, [debouncedQ, source, isFal, libCategory, similar, brandId, activeTag, activeChar]);

  // Initial load + reload on filter change (resets to first page).
  useEffect(() => {
    setLimit(60);
    loadPage(60, false);
  }, [loadPage]);

  // Clear taxonomy filters when leaving fal.
  useEffect(() => {
    if (!isFal) { setActiveTag(null); setActiveChar(null); }
  }, [source]);

  const loadMore = useCallback(() => {
    const next = limit + 60;
    setLimit(next);
    loadPage(next, true);
  }, [limit, loadPage]);

  // ── Library maintenance: refresh, import-from-Drive, background re-index.
  // Mirrors the editor's Brand tab so the canvas Asset Library can be kept
  // fresh without leaving the canvas.
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncMsg, setSyncMsg] = useState("");
  const [embedMsg, setEmbedMsg] = useState("");
  const embedLoopRef = useRef(false);
  const startEmbedLoop = useCallback(async (bId: string) => {
    if (embedLoopRef.current || !bId) return;
    embedLoopRef.current = true;
    try {
      for (let i = 0; i < 200; i++) {
        const r = await fetch("/api/brand-assets/embed-skipped", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ brandId: bId }) });
        const j = (await r.json()) as { ok?: boolean; started?: number; remaining?: number; error?: string };
        if (!r.ok || j.error) { setEmbedMsg(""); break; }
        if (!j.remaining) { setEmbedMsg(j.started || i > 0 ? "Indexing done." : ""); setTimeout(() => setEmbedMsg(""), 4000); break; }
        setEmbedMsg(`Indexing… ${j.remaining} left`);
      }
    } catch { setEmbedMsg(""); }
    embedLoopRef.current = false;
  }, []);
  const refreshAssets = useCallback(() => { setSyncMsg(""); loadPage(limit, false); }, [limit, loadPage]);
  const reindex = useCallback(() => { if (brandSel) void startEmbedLoop(brandSel); }, [brandSel, startEmbedLoop]);
  const syncDrive = useCallback(async () => {
    if (!brandSel) { setSyncMsg("Pick a brand first."); return; }
    setSyncBusy(true); setSyncMsg("Checking Drive…");
    try {
      let total = 0;
      for (let i = 0; i < 60; i++) {
        const ctl = new AbortController();
        const tmo = setTimeout(() => ctl.abort(), 120000);
        const r = await fetch("/api/drive/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ brandId: brandSel }), signal: ctl.signal }).finally(() => clearTimeout(tmo));
        const j = (await r.json()) as { ok?: boolean; imported?: number; remaining?: number; error?: string };
        if (!r.ok || j.error) { setSyncMsg(`Sync failed: ${j.error || r.status}`); setSyncBusy(false); return; }
        total += j.imported || 0;
        if (!j.remaining) { setSyncMsg(total ? `Imported ${total} new.` : "Up to date."); void startEmbedLoop(brandSel); break; }
        setSyncMsg(`Imported ${total}… ${j.remaining} left`);
      }
      loadPage(limit, false);
    } catch (e) {
      setSyncMsg(e instanceof DOMException && e.name === "AbortError" ? "Batch timed out — press Sync Drive again." : `Sync failed: ${e instanceof Error ? e.message : "error"}`);
    }
    setSyncBusy(false);
  }, [brandSel, limit, loadPage, startEmbedLoop]);

  // Tab filter is purely local now → instant switching, no refetch.
  const [sortBy, setSortBy] = useState<"newest" | "name" | "kind">("newest");
  const [aspect, setAspect] = useState<string>("all");
  const [dims, setDims] = useState<Record<string, string>>({});
  const noteDims = (url: string, w: number, h: number) => { if (w && h) setDims((p) => (p[url] ? p : { ...p, [url]: `${w}×${h}` })); };
  const [durs, setDurs] = useState<Record<string, string>>({});
  const fmtDur = (s: number) => { if (!isFinite(s) || s <= 0) return ""; const m = Math.floor(s / 60), ss = Math.round(s % 60); return `${m}:${String(ss).padStart(2, "0")}`; };
  const noteDur = (url: string, sec: number) => { const f = fmtDur(sec); if (f) setDurs((p) => (p[url] ? p : { ...p, [url]: f })); };
  // Delete a generated/uploaded asset (our DB rows only — not fal or curated
  // library items). Removes it from the site (DB row + storage) and the list.
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const deleteAsset = async (a: AssetItem) => {
    if (isFal || source !== "generated" || !a.id) return;
    if (!window.confirm("Delete this asset permanently? It will be removed from the site.")) return;
    setDeletingId(a.id);
    try {
      const res = await fetch(`/api/assets?id=${encodeURIComponent(a.id)}`, { method: "DELETE" });
      if (res.ok) setAssets((prev) => prev.filter((x) => x.id !== a.id));
      else window.alert("Delete failed.");
    } catch { window.alert("Delete failed."); }
    finally { setDeletingId(null); }
  };
  // Bucket an asset into a standard aspect ratio from its measured pixel size.
  // Returns null until dimensions are known (probed lazily + eagerly below).
  const aspectBucket = (url: string): string | null => {
    const d = dims[url]; if (!d) return null;
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
  };
  const extOf = (url: string) => { const m = url.split("?")[0].match(/\.([a-z0-9]{2,4})$/i); return m ? m[1].toUpperCase() : ""; };
  const nameOf = (a: AssetItem) => a.prompt || a.model || a.kind;
  const visibleBase = source === "library" && libSub !== "all" ? assets.filter((a) => subByUrl[a.cdnUrl] === libSub) : assets;
  const visibleKind = kind ? visibleBase.filter((a) => a.kind === kind) : visibleBase;
  const visibleAspect = aspect === "all" ? visibleKind : visibleKind.filter((a) => aspectBucket(a.cdnUrl) === aspect);
  const visible = sortBy === "newest" ? visibleAspect : [...visibleAspect].sort((a, b) =>
    sortBy === "name" ? nameOf(a).localeCompare(nameOf(b)) : a.kind.localeCompare(b.kind) || nameOf(a).localeCompare(nameOf(b)));

  // Stop wheel from reaching the canvas. The canvas binds a NATIVE wheel
  // listener on its own element, which fires on bubble BEFORE React's
  // delegated onWheel — so React stopPropagation doesn't help. We bind a
  // native listener on the drawer root and stop propagation there, before
  // the event bubbles up to the canvas element.
  const rootRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadingSearch, setUploadingSearch] = useState(false);

  // Upload a user image to fal, then use its fal-hosted URL as the
  // "similar to" reference for semantic image search.
  const onSearchImagePicked = useCallback(async (file: File) => {
    setUploadingSearch(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/fal-upload", { method: "POST", body: fd });
      const data = await res.json();
      if (data.url) {
        setQ("");
        setSimilar({ url: data.url, kind: "image", label: "uploaded image" });
      }
    } catch {
      /* ignore */
    } finally {
      setUploadingSearch(false);
    }
  }, []);
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const stop = (e: WheelEvent) => e.stopPropagation();
    el.addEventListener("wheel", stop, { passive: true });
    return () => el.removeEventListener("wheel", stop);
  }, []);

  // Eagerly measure media dimensions for the current list so the aspect-ratio
  // filter can bucket assets even before their (lazy) thumbnail scrolls in.
  // Images/videos already in `dims` are skipped; videos load metadata only.
  useEffect(() => {
    const els: HTMLMediaElement[] = [];
    for (const a of assets) {
      if (a.kind === "video") {
        if (dims[a.cdnUrl] && durs[a.cdnUrl]) continue;
        const v = document.createElement("video");
        v.preload = "metadata"; v.muted = true;
        v.onloadedmetadata = () => { noteDims(a.cdnUrl, v.videoWidth, v.videoHeight); noteDur(a.cdnUrl, v.duration); };
        v.src = a.cdnUrl; els.push(v);
      } else if (a.kind === "audio") {
        if (durs[a.cdnUrl]) continue;
        const au = document.createElement("audio");
        au.preload = "metadata";
        au.onloadedmetadata = () => noteDur(a.cdnUrl, au.duration);
        au.src = a.cdnUrl; els.push(au);
      } else if (a.kind === "image") {
        if (dims[a.cdnUrl]) continue;
        const img = new Image();
        img.onload = () => noteDims(a.cdnUrl, img.naturalWidth, img.naturalHeight);
        img.src = a.cdnUrl;
      }
    }
    return () => { els.forEach((e) => { e.onloadedmetadata = null; e.src = ""; }); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assets]);

  return (
    <div
      ref={rootRef}
      className="absolute top-0 right-0 h-full w-[340px] z-30 glass-strong flex flex-col"
      onPointerDown={(e) => e.stopPropagation()}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 h-12 border-b border-border">
        <span className="text-[12px] font-semibold text-fg">Asset library</span>
        <button onClick={onClose} className="text-fg-subtle hover:text-fg"><X size={16} /></button>
      </div>

      {/* Filters */}
      <div
        className="p-3 space-y-2 border-b border-border"
        onDragOver={(e) => {
          if (source === "library" || isFal) {
            e.preventDefault();
            setDragOver(true);
          }
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          if (source !== "library" && !isFal) return;
          e.preventDefault();
          setDragOver(false);
          const f = e.dataTransfer.files?.[0];
          if (f && f.type.startsWith("image/")) onSearchImagePicked(f);
        }}
        style={dragOver ? { outline: "2px dashed var(--brand)", outlineOffset: "-4px" } : undefined}
      >
        {/* Source switch — Library (curated + brand UI) and Generated. */}
        <div className="flex gap-1">
          <button
            onClick={() => setSource("library")}
            className={`flex-1 px-2 py-1 rounded text-[10px] border transition ${
              source === "library" ? "bg-brand/15 border-brand text-brand" : "border-border text-fg-muted hover:text-fg"
            }`}
          >
            Library
          </button>
          <button
            onClick={() => setSource("generated")}
            className={`flex-1 px-2 py-1 rounded text-[10px] border transition ${
              source === "generated" ? "bg-brand/15 border-brand text-brand" : "border-border text-fg-muted hover:text-fg"
            }`}
          >
            Generated
          </button>
        </div>
        <p className="text-[9px] text-fg-subtle leading-tight">
          {source === "library"
            ? "Your saved brand assets + brand-kit UI — search by meaning (text or image)."
            : "Generated content. Switch between this project and your full fal.ai library."}
        </p>

        {/* Library maintenance — refresh, import from Drive, background re-index. */}
        {source === "library" && (
          <div className="space-y-1">
            <div className="flex gap-1">
              <button onClick={refreshAssets} disabled={loading} title="Reload assets" className="flex-1 inline-flex items-center justify-center gap-1 px-1.5 py-1 rounded text-[10px] border border-border text-fg-muted hover:text-fg hover:border-brand disabled:opacity-50">
                <RefreshCw size={11} className={loading ? "animate-spin" : ""} /> Refresh
              </button>
              <button onClick={syncDrive} disabled={syncBusy || !brandSel} title="Import all new files from the brand's Google Drive, then index" className="flex-1 inline-flex items-center justify-center gap-1 px-1.5 py-1 rounded text-[10px] border border-border text-fg-muted hover:text-fg hover:border-brand disabled:opacity-50">
                <Cloud size={11} className={syncBusy ? "animate-pulse" : ""} /> Sync Drive
              </button>
              <button onClick={reindex} disabled={!brandSel} title="Run semantic indexing in the background" className="flex-1 inline-flex items-center justify-center gap-1 px-1.5 py-1 rounded text-[10px] border border-border text-fg-muted hover:text-fg hover:border-brand disabled:opacity-50">
                <Sparkles size={11} /> Reindex
              </button>
            </div>
            {(syncMsg || embedMsg) && (
              <p className="text-[9px] text-fg-subtle">{syncMsg}{syncMsg && embedMsg ? " · " : ""}{embedMsg}</p>
            )}
          </div>
        )}

        {/* Generated: sub-source (our projects vs fal) */}
        {source === "generated" && (
          <div className="flex gap-1">
            <button
              onClick={() => setGenSource("projects")}
              className={`px-2 py-0.5 rounded-full text-[10px] border transition ${
                genSource === "projects" ? "bg-brand/15 border-brand text-brand" : "border-border text-fg-muted hover:text-fg"
              }`}
            >
              My projects
            </button>
            <button
              onClick={() => setGenSource("fal")}
              className={`px-2 py-0.5 rounded-full text-[10px] border transition ${
                genSource === "fal" ? "bg-brand/15 border-brand text-brand" : "border-border text-fg-muted hover:text-fg"
              }`}
            >
              fal library
            </button>
          </div>
        )}

        {/* Library: category chips */}
        {(source === "library" || source === "generated" || source === "ui") && !isFal && brandOpts.length > 0 && (
          <select value={brandSel} onChange={(e) => { setBrandSel(e.target.value); setLibSub("all"); }}
            className="w-full bg-bg border border-border rounded px-1.5 py-1 text-[11px] text-fg outline-none">
            <option value="">All brands</option>
            {brandOpts.map((b) => <option key={b.value} value={b.value}>{b.label}</option>)}
          </select>
        )}
        {source === "library" && (
          <div className="flex flex-wrap gap-1">
            {["all", "logo", "ui", "store", "graphic", "overlay", "music", "sound", "reference", "hook", "body", "packshot", "other"].map((c) => (
              <button
                key={c}
                onClick={() => { setLibCategory(c); setLibSub("all"); }}
                className={`px-2 py-0.5 rounded-full text-[9px] border transition ${
                  libCategory === c ? "bg-brand/15 border-brand text-brand" : "border-border text-fg-muted hover:text-fg"
                }`}
              >
                {c === "all" ? "All" : c}
              </button>
            ))}
          </div>
        )}
        {source === "library" && (() => {
          const subs = Array.from(new Set(Object.values(subByUrl))).sort();
          if (!subs.length) return null;
          return subs.length <= 6 ? (
            <div className="flex flex-wrap items-center gap-1 text-[9px]">
              <span className="text-fg-subtle">↳</span>
              {["all", ...subs].map((sp) => (
                <button key={sp} onClick={() => setLibSub(sp)} title={sp}
                  className={`px-2 py-0.5 rounded-full border max-w-[110px] truncate transition ${libSub === sp ? "bg-brand/15 border-brand text-brand" : "border-border text-fg-muted hover:text-fg"}`}>
                  {sp}
                </button>
              ))}
            </div>
          ) : (
            <label className="flex items-center gap-1.5 text-[10px] text-fg-subtle">↳
              <select value={libSub} onChange={(e) => setLibSub(e.target.value)} className="flex-1 bg-bg border border-border rounded px-1.5 py-1 text-[11px] text-fg outline-none">
                <option value="all">All subfolders ({subs.length})</option>
                {subs.map((sp) => <option key={sp} value={sp}>{sp}</option>)}
              </select>
            </label>
          );
        })()}
        <div className="flex gap-1.5">
          <div className="relative flex-1">
            <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-subtle" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={source === "library" || isFal ? "Semantic search…" : "Search…"}
              className="w-full bg-bg border border-border rounded-md pl-7 pr-2 py-1.5 text-[11px] text-fg outline-none focus:border-brand"
            />
          </div>
          {(source === "library" || isFal) && (
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) onSearchImagePicked(f);
                e.target.value = "";
              }}
            />
          )}
        </div>
        {source !== "ui" && (
          <>
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
            <select value={sortBy} onChange={(e) => setSortBy(e.target.value as typeof sortBy)} className="ml-auto bg-bg border border-border rounded px-1 py-0.5 text-[10px] text-fg-muted outline-none">
            <option value="newest">Newest</option><option value="name">Name</option><option value="kind">Type</option>
          </select>
        </div>
          <div className="flex items-center gap-1.5">
            <span className="text-[9px] uppercase tracking-wider text-fg-subtle shrink-0">Ratio</span>
            <select
              value={aspect}
              onChange={(e) => setAspect(e.target.value)}
              className="flex-1 bg-bg border border-border rounded px-1 py-0.5 text-[10px] text-fg-muted outline-none"
              title="Filter assets by aspect ratio (resolution)"
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
          </>
        )}
        {/* Explicit drop zone for image search (clear where to drop). */}
        {(source === "library" || isFal) && !similar && (
          <button
            onClick={() => fileInputRef.current?.click()}
            className="w-full flex items-center justify-center gap-1.5 rounded-md border border-dashed border-border text-fg-subtle hover:text-fg hover:border-brand text-[10px] py-2 transition"
          >
            {uploadingSearch ? <Loader2 size={12} className="animate-spin" /> : <ImageIcon size={12} />}
            {uploadingSearch ? "Uploading…" : "Drop an image here, or click to search by image"}
          </button>
        )}
      </div>

      {/* fal: characters + tags */}
      {isFal && (characters.length > 0 || tags.length > 0) && (
        <div className="px-3 py-2 border-b border-border space-y-2">
          {characters.length > 0 && (
            <div className="flex gap-2 overflow-x-auto pb-1">
              {characters.map((c) => {
                const on = activeChar === c.identifier;
                return (
                  <button
                    key={c.id}
                    onClick={() => c.identifier && setActiveChar(on ? null : c.identifier)}
                    disabled={!c.identifier}
                    title={c.name}
                    className={`flex-shrink-0 flex flex-col items-center gap-1 ${!c.identifier ? "opacity-40" : ""}`}
                  >
                    <span className={`w-9 h-9 rounded-full overflow-hidden border-2 ${on ? "border-brand" : "border-transparent"}`}>
                      {c.cover ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={c.cover} alt="" loading="lazy" decoding="async" className="w-full h-full object-cover" />
                      ) : (
                        <span className="w-full h-full flex items-center justify-center bg-bg text-fg-subtle text-[10px]">
                          {c.name.slice(0, 1)}
                        </span>
                      )}
                    </span>
                    <span className="text-[8px] text-fg-muted max-w-[44px] truncate">{c.name}</span>
                  </button>
                );
              })}
            </div>
          )}
          {tags.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {tags.map((t) => {
                const on = activeTag === t.id;
                return (
                  <button
                    key={t.id}
                    onClick={() => setActiveTag(on ? null : t.id)}
                    className={`px-2 py-0.5 rounded-full text-[9px] border transition ${
                      on ? "bg-brand/15 border-brand text-brand" : "border-border text-fg-muted hover:text-fg"
                    }`}
                  >
                    #{t.name}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Similar-search banner */}
      {(source === "library" || isFal) && similar && (
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
          <p className="text-center text-fg-subtle text-[11px] py-12">
            {source === "library" && !debouncedQ && !similar
              ? "Pick a category to browse, type to search, or drop an image."
              : "No assets."}
          </p>
        ) : (
          <div className="grid grid-cols-2 gap-x-2 gap-y-5">
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
                onMouseEnter={(e) => { const v = e.currentTarget.querySelector("video"); if (v) (v as HTMLVideoElement).play().catch(() => {}); }}
                onMouseLeave={(e) => { const v = e.currentTarget.querySelector("video"); if (v) { (v as HTMLVideoElement).pause(); (v as HTMLVideoElement).currentTime = 0; } }}
                className="group relative aspect-square rounded-md overflow-hidden bg-bg border border-border hover:border-brand cursor-grab active:cursor-grabbing"
              >
                {a.kind === "image" && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={a.cdnUrl} alt="" onLoad={(e) => noteDims(a.cdnUrl, e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)} className="w-full h-full object-cover pointer-events-none" loading="lazy" />
                )}
                {a.kind === "video" && (
                  <video src={a.cdnUrl} onLoadedMetadata={(e) => { noteDims(a.cdnUrl, e.currentTarget.videoWidth, e.currentTarget.videoHeight); noteDur(a.cdnUrl, e.currentTarget.duration); }} className="w-full h-full object-cover pointer-events-none" muted loop preload="metadata" />
                )}
                {a.kind === "audio" && (
                  <div className="w-full h-full flex items-center justify-center text-fg-subtle relative"><Music size={20} />
                    <button onClick={(e) => { e.stopPropagation(); togglePreview(a.cdnUrl); }} title={previewingUrl === a.cdnUrl ? "Stop" : "Preview"}
                      className="absolute bottom-1 right-1 w-6 h-6 grid place-items-center rounded-full bg-black/70 text-white hover:bg-black/90">
                      {previewingUrl === a.cdnUrl ? <Pause size={11} /> : <Play size={11} />}
                    </button>
                  </div>
                )}
                {a.kind === "text" && (
                  <div className="w-full h-full flex items-center justify-center p-2 text-fg-muted text-[8px] overflow-hidden">
                    {a.prompt?.slice(0, 80)}
                  </div>
                )}
                <span className="absolute top-1 left-1 px-1 py-0.5 rounded bg-black/50 text-[7px] uppercase text-white/80">
                  {a.kind}
                </span>
                {source === "generated" && !isFal && a.id && (
                  <button
                    onClick={(e) => { e.stopPropagation(); void deleteAsset(a); }}
                    title="Delete asset permanently"
                    className="absolute top-1 right-1 w-6 h-6 grid place-items-center rounded-full bg-black/70 text-white/90 hover:bg-red-600 opacity-0 group-hover:opacity-100 transition z-10"
                  >
                    {deletingId === a.id ? <Loader2 size={11} className="animate-spin" /> : <Trash2 size={11} />}
                  </button>
                )}
                {extOf(a.cdnUrl) && a.kind !== "video" && a.kind !== "audio" && <span className="absolute bottom-1 left-1 px-1 rounded bg-black/60 text-[7px] text-white/70">{extOf(a.cdnUrl)}</span>}
                {durs[a.cdnUrl] && (a.kind === "video" || a.kind === "audio") && <span className="absolute bottom-1 left-1 px-1 rounded bg-black/60 text-[7px] text-white/80">{durs[a.cdnUrl]}</span>}
                {dims[a.cdnUrl] && <span className="absolute bottom-1 right-1 px-1 rounded bg-black/60 text-[7px] text-white/70">{dims[a.cdnUrl]}</span>}
                {subByUrl[a.cdnUrl] && <span className="absolute top-1 right-1 px-1 rounded bg-black/60 text-[7px] text-white/80">{subByUrl[a.cdnUrl]}</span>}
                <div className="absolute inset-x-0 bottom-0 translate-y-full pt-0.5 text-[8px] text-fg-subtle truncate pointer-events-none">{nameOf(a)}</div>
              </div>
            ))}
          </div>
        )}

        {/* Load more — only when not filtering tabs locally to a subset */}
        {!loading && hasMore && (!kind || visible.length >= 4) && (
          <button
            onClick={loadMore}
            disabled={loadingMore}
            className="w-full mt-3 py-2 rounded-md border border-border text-fg-muted hover:text-fg hover:border-border-strong text-[11px] transition disabled:opacity-50"
          >
            {loadingMore ? "Loading…" : "Load more"}
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
          <div className="bg-bg-subtle flex items-center justify-center" style={{ maxHeight: "45%" }}>
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
          {brandId && (
            <div className="px-3 pb-3 -mt-1 flex justify-end">
              <SaveToLibraryButton url={preview.cdnUrl} kind={preview.kind} label={preview.prompt || undefined} brandId={brandId} compact />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
