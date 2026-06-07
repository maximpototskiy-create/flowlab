"use client";

import { useCallback, useRef, useState } from "react";
import {
  Film, ImageIcon, Music, Type, Plus, Trash2, ChevronLeft, ChevronRight,
  Play, Pause, Download, Loader2, Clapperboard,
} from "lucide-react";

export type EditorAsset = {
  id: string;
  url: string;
  kind: "video" | "image" | "audio";
  label: string;
  duration: number | null;
};

type Track = "video" | "audio" | "text";
type EditClip = {
  id: string;
  track: Track;
  kind: "video" | "image" | "audio" | "text";
  url?: string;
  text?: string;
  label: string;
  duration: number; // seconds shown on the timeline
  start: number; // start time on the timeline (text track only; video/audio are sequential)
};

const RESOLUTIONS = [
  { key: "9:16", label: "Portrait 9:16", w: 1080, h: 1920 },
  { key: "16:9", label: "Landscape 16:9", w: 1920, h: 1080 },
  { key: "1:1", label: "Square 1:1", w: 1080, h: 1080 },
];
const PX_PER_SEC = 48;
const DEFAULT_IMAGE_DUR = 3;
const DEFAULT_TEXT_DUR = 3;

// The editor engine (@diffusionstudio/core) is a WebCodecs/WASM browser library
// that breaks the Next.js server build if bundled. So we load it from a CDN at
// RUNTIME, in the browser only. `new Function` hides the import from the
// bundler entirely (webpack/turbopack never tries to resolve or bundle it),
// which also keeps it out of package.json/lockfile. Cached after first load.
const ENGINE_CDN = "https://esm.sh/@diffusionstudio/core@4.0.3";
let _enginePromise: Promise<any> | null = null;
function loadEngine(): Promise<any> {
  if (!_enginePromise) {
    const dynImport = new Function("u", "return import(u)") as (u: string) => Promise<any>;
    _enginePromise = dynImport(ENGINE_CDN);
  }
  return _enginePromise;
}

let _id = 0;
const uid = () => `c${Date.now()}_${_id++}`;

export default function VideoEditor({ assets }: { assets: EditorAsset[] }) {
  const [clips, setClips] = useState<EditClip[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [binFilter, setBinFilter] = useState<"all" | "video" | "image" | "audio">("all");
  const [resKey, setResKey] = useState("9:16");
  const [building, setBuilding] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const previewRef = useRef<HTMLDivElement | null>(null);
  const compRef = useRef<unknown>(null); // current diffusionstudio Composition

  const res = RESOLUTIONS.find((r) => r.key === resKey)!;
  const filteredBin = assets.filter((a) => binFilter === "all" || a.kind === binFilter);

  const byTrack = (t: Track) => clips.filter((c) => c.track === t);

  // ── editing ops ──
  const addAsset = (a: EditorAsset) => {
    const track: Track = a.kind === "audio" ? "audio" : "video";
    const duration = a.duration ?? (a.kind === "image" ? DEFAULT_IMAGE_DUR : a.kind === "audio" ? 5 : 4);
    setClips((prev) => [
      ...prev,
      { id: uid(), track, kind: a.kind, url: a.url, label: a.label, duration, start: 0 },
    ]);
  };
  const addText = () => {
    const existing = byTrack("text");
    const start = existing.reduce((m, c) => Math.max(m, c.start + c.duration), 0);
    setClips((prev) => [
      ...prev,
      { id: uid(), track: "text", kind: "text", text: "Your caption", label: "Text", duration: DEFAULT_TEXT_DUR, start },
    ]);
  };
  const update = (id: string, patch: Partial<EditClip>) =>
    setClips((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  const remove = (id: string) =>
    setClips((prev) => prev.filter((c) => c.id !== id));
  const move = (id: string, dir: -1 | 1) =>
    setClips((prev) => {
      const c = prev.find((x) => x.id === id);
      if (!c) return prev;
      const sameTrack = prev.filter((x) => x.track === c.track);
      const idx = sameTrack.indexOf(c);
      const swap = sameTrack[idx + dir];
      if (!swap) return prev;
      const next = [...prev];
      const i1 = next.indexOf(c), i2 = next.indexOf(swap);
      [next[i1], next[i2]] = [next[i2], next[i1]];
      return next;
    });

  // ── build a diffusionstudio Composition from the current tracks ──
  // Lazy-imported so the WebCodecs engine never loads during SSR.
  const buildComposition = useCallback(async () => {
    const DS: any = await loadEngine();
    const comp = new DS.Composition({ width: res.w, height: res.h, background: "#000000" });

    // video/image track — sequential, back to back
    const vLayer = new DS.Layer();
    let vt = 0;
    for (const c of clips.filter((x) => x.track === "video")) {
      try {
        const src = await DS.Source.from(c.url);
        const clip = c.kind === "video" ? new DS.VideoClip(src) : new DS.ImageClip(src);
        clip.start = vt;
        try { clip.stop = vt + c.duration; } catch { /* duration via default */ }
        if (c.kind === "video") { try { clip.trim(0, c.duration); } catch { /* no trim */ } }
        vLayer.add(clip);
        vt += c.duration;
      } catch (e) {
        console.error("[editor] video clip failed", c, e);
      }
    }
    await comp.add(vLayer);

    // audio track — sequential
    const aLayer = new DS.Layer();
    let at = 0;
    for (const c of clips.filter((x) => x.track === "audio")) {
      try {
        const src = await DS.Source.from(c.url);
        const clip = new DS.AudioClip(src);
        clip.start = at;
        try { clip.stop = at + c.duration; } catch { /* full length */ }
        aLayer.add(clip);
        at += c.duration;
      } catch (e) {
        console.error("[editor] audio clip failed", c, e);
      }
    }
    await comp.add(aLayer);

    // text/caption track — explicit start
    const tLayer = new DS.Layer();
    for (const c of clips.filter((x) => x.track === "text")) {
      try {
        const clip = new DS.TextClip({
          text: c.text ?? "",
          x: res.w / 2, y: res.h * 0.82, anchor: 0.5,
          fontSize: Math.round(res.w / 18), fill: "#ffffff",
          stroke: "#000000", strokeWidth: 4, textAlign: "center",
        });
        clip.start = c.start;
        try { clip.stop = c.start + c.duration; } catch { /* default */ }
        tLayer.add(clip);
      } catch (e) {
        console.error("[editor] text clip failed", c, e);
      }
    }
    await comp.add(tLayer);

    return comp;
  }, [clips, res]);

  // ── preview ──
  const buildPreview = useCallback(async () => {
    if (building || clips.length === 0) return;
    setBuilding(true);
    setStatus("Building preview…");
    try {
      const prev = compRef.current as { unmount?: () => void } | null;
      try { prev?.unmount?.(); } catch { /* ignore */ }
      const comp = await buildComposition();
      compRef.current = comp;
      if (previewRef.current) {
        previewRef.current.innerHTML = "";
        (comp as { mount: (el: HTMLElement) => void }).mount(previewRef.current);
      }
      await (comp as { seek: (t: number) => Promise<void> }).seek(0);
      setStatus(null);
    } catch (e) {
      console.error(e);
      setStatus("Preview failed — check console. The engine may need a tweak for these assets.");
    } finally {
      setBuilding(false);
      setPlaying(false);
    }
  }, [building, clips.length, buildComposition]);

  const togglePlay = useCallback(async () => {
    const comp = compRef.current as { play: () => Promise<void>; pause: () => Promise<void>; playing?: boolean } | null;
    if (!comp) { await buildPreview(); return; }
    try {
      if (playing) { await comp.pause(); setPlaying(false); }
      else { await comp.play(); setPlaying(true); }
    } catch (e) { console.error(e); }
  }, [playing, buildPreview]);

  // ── export ──
  const exportMp4 = useCallback(async () => {
    if (exporting || clips.length === 0) return;
    setExporting(true);
    setStatus("Rendering MP4 in your browser… this can take a while.");
    try {
      const DS: any = await loadEngine();
      const comp = await buildComposition();
      const result = await new DS.Encoder(comp).render();
      const blob: Blob = result instanceof Blob ? result : (result?.blob ?? result);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `flowlab-export-${Date.now()}.mp4`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setStatus("Done — MP4 downloaded.");
    } catch (e) {
      console.error(e);
      setStatus("Export failed — check console.");
    } finally {
      setExporting(false);
    }
  }, [exporting, clips.length, buildComposition]);

  const totalDur = Math.max(
    byTrack("video").reduce((s, c) => s + c.duration, 0),
    byTrack("audio").reduce((s, c) => s + c.duration, 0),
    byTrack("text").reduce((m, c) => Math.max(m, c.start + c.duration), 0),
  );
  const sel = clips.find((c) => c.id === selected) ?? null;

  return (
    <div className="flex-1 flex min-h-0">
      {/* ── Asset bin ── */}
      <aside className="w-64 shrink-0 border-r border-border flex flex-col">
        <div className="h-11 border-b border-border flex items-center gap-1 px-2 text-[11px]">
          {(["all", "video", "image", "audio"] as const).map((f) => (
            <button
              key={f}
              onClick={() => setBinFilter(f)}
              className={`px-2 py-1 rounded ${binFilter === f ? "bg-brand/15 text-brand" : "text-fg-muted hover:text-fg"}`}
            >
              {f}
            </button>
          ))}
        </div>
        <div className="flex-1 overflow-y-auto p-2 grid grid-cols-2 gap-2 content-start">
          {filteredBin.map((a) => (
            <button
              key={a.id}
              onClick={() => addAsset(a)}
              title={a.label}
              className="group relative aspect-square rounded-md overflow-hidden bg-bg-card border border-border hover:border-brand"
            >
              {a.kind === "image" || a.kind === "video" ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={a.url} alt="" className="w-full h-full object-cover" loading="lazy" />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-fg-subtle"><Music size={20} /></div>
              )}
              <span className="absolute top-1 left-1 px-1 rounded bg-black/60 text-[8px] uppercase text-white/80">{a.kind}</span>
              <span className="absolute inset-0 bg-black/0 group-hover:bg-black/30 flex items-center justify-center opacity-0 group-hover:opacity-100">
                <Plus size={18} className="text-white" />
              </span>
            </button>
          ))}
          {filteredBin.length === 0 && <div className="col-span-2 text-fg-subtle text-[11px] p-3">No assets.</div>}
        </div>
        <button onClick={addText} className="m-2 inline-flex items-center justify-center gap-1.5 py-2 rounded-md border border-border text-fg-muted hover:text-fg text-[12px]">
          <Type size={13} /> Add text
        </button>
      </aside>

      {/* ── Main: preview + timeline ── */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Toolbar */}
        <div className="h-11 border-b border-border flex items-center justify-between px-3 gap-2">
          <div className="flex items-center gap-2 text-fg text-[13px] font-medium">
            <Clapperboard size={14} className="text-brand" /> Editor
          </div>
          <div className="flex items-center gap-2">
            <select value={resKey} onChange={(e) => setResKey(e.target.value)} className="bg-bg-card border border-border rounded-md px-2 py-1 text-[11px] text-fg-muted outline-none">
              {RESOLUTIONS.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
            </select>
            <button onClick={buildPreview} disabled={building || !clips.length} className="px-3 py-1.5 rounded-md border border-border text-fg-muted hover:text-fg text-[12px] disabled:opacity-50 inline-flex items-center gap-1.5">
              {building ? <Loader2 size={13} className="animate-spin" /> : <Film size={13} />} Preview
            </button>
            <button onClick={exportMp4} disabled={exporting || !clips.length} className="px-3 py-1.5 rounded-md bg-brand text-black font-medium text-[12px] disabled:opacity-50 inline-flex items-center gap-1.5">
              {exporting ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />} Export MP4
            </button>
          </div>
        </div>

        {/* Preview */}
        <div className="flex-1 min-h-0 bg-black flex items-center justify-center p-4">
          <div ref={previewRef} className="max-h-full max-w-full [&>canvas]:max-h-full [&>canvas]:max-w-full [&>canvas]:object-contain" style={{ aspectRatio: `${res.w}/${res.h}` }} />
        </div>

        {/* Transport + status */}
        <div className="h-9 border-t border-border flex items-center gap-3 px-3 text-[11px] text-fg-muted">
          <button onClick={togglePlay} className="text-fg hover:text-brand">{playing ? <Pause size={15} /> : <Play size={15} />}</button>
          <span className="tabular-nums">{totalDur.toFixed(1)}s total</span>
          {status && <span className="text-fg-subtle truncate">· {status}</span>}
        </div>

        {/* Timeline */}
        <div className="h-44 border-t border-border overflow-auto bg-bg-card/40">
          {(["video", "audio", "text"] as Track[]).map((track) => (
            <div key={track} className="flex items-stretch border-b border-border/60 min-h-[44px]">
              <div className="w-16 shrink-0 flex items-center justify-center text-[9px] uppercase tracking-wider text-fg-subtle border-r border-border/60">
                {track}
              </div>
              <div className="flex-1 flex items-center gap-1 p-1.5">
                {byTrack(track).map((c) => (
                  <button
                    key={c.id}
                    onClick={() => setSelected(c.id)}
                    style={{ width: Math.max(40, c.duration * PX_PER_SEC) }}
                    className={`h-8 shrink-0 rounded px-2 text-[10px] truncate text-left border ${
                      selected === c.id ? "border-brand bg-brand/15 text-brand" : "border-border bg-bg-card text-fg-muted"
                    }`}
                    title={c.label}
                  >
                    {c.kind === "text" ? (c.text || "Text") : c.label}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* Selected clip inspector */}
        {sel && (
          <div className="border-t border-border p-2 flex items-center gap-3 text-[11px] flex-wrap">
            <span className="text-fg-subtle uppercase tracking-wider">{sel.kind}</span>
            {sel.kind === "text" && (
              <input value={sel.text ?? ""} onChange={(e) => update(sel.id, { text: e.target.value })}
                className="bg-bg-card border border-border rounded px-2 py-1 text-fg w-56 outline-none focus:border-brand" placeholder="Caption text" />
            )}
            <label className="flex items-center gap-1 text-fg-muted">
              dur
              <input type="number" min={0.5} step={0.5} value={sel.duration}
                onChange={(e) => update(sel.id, { duration: Math.max(0.5, Number(e.target.value) || 0.5) })}
                className="bg-bg-card border border-border rounded px-1.5 py-1 w-16 text-fg outline-none focus:border-brand" />s
            </label>
            {sel.track === "text" && (
              <label className="flex items-center gap-1 text-fg-muted">
                start
                <input type="number" min={0} step={0.5} value={sel.start}
                  onChange={(e) => update(sel.id, { start: Math.max(0, Number(e.target.value) || 0) })}
                  className="bg-bg-card border border-border rounded px-1.5 py-1 w-16 text-fg outline-none focus:border-brand" />s
              </label>
            )}
            <button onClick={() => move(sel.id, -1)} className="text-fg-muted hover:text-fg"><ChevronLeft size={15} /></button>
            <button onClick={() => move(sel.id, 1)} className="text-fg-muted hover:text-fg"><ChevronRight size={15} /></button>
            <button onClick={() => { remove(sel.id); setSelected(null); }} className="text-red-400 hover:text-red-300 inline-flex items-center gap-1"><Trash2 size={13} /> delete</button>
          </div>
        )}
      </div>
    </div>
  );
}
