"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Music, Type, Plus, Trash2, Play, Pause, SkipBack,
  Download, Clapperboard, ZoomIn, ZoomOut,
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
  start: number; // seconds
  duration: number; // seconds
};

const RESOLUTIONS = [
  { key: "9:16", label: "Portrait 9:16", w: 1080, h: 1920 },
  { key: "16:9", label: "Landscape 16:9", w: 1920, h: 1080 },
  { key: "1:1", label: "Square 1:1", w: 1080, h: 1080 },
];
const TRACKS: Track[] = ["video", "audio", "text"];
const DEFAULTS = { image: 4, audio: 6, video: 4, text: 3 };
const MIN_DUR = 0.3;

let _id = 0;
const uid = () => `c${Date.now()}_${_id++}`;
const fmt = (s: number) => `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, "0")}`;

export default function VideoEditor({ assets }: { assets: EditorAsset[] }) {
  const [clips, setClips] = useState<EditClip[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [binFilter, setBinFilter] = useState<"all" | "video" | "image" | "audio">("all");
  const [resKey, setResKey] = useState("9:16");
  const [pxPerSec, setPxPerSec] = useState(60);
  const [playing, setPlaying] = useState(false);
  const [playhead, setPlayhead] = useState(0);
  const [previewSize, setPreviewSize] = useState({ w: 0, h: 0 });
  const [status, setStatus] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const mediaRefs = useRef<Map<string, HTMLVideoElement | HTMLAudioElement>>(new Map());
  const rafRef = useRef<number | null>(null);
  const lastTsRef = useRef(0);
  const playingRef = useRef(false);
  const playheadRef = useRef(0);
  const clipsRef = useRef<EditClip[]>([]);
  clipsRef.current = clips;

  const res = RESOLUTIONS.find((r) => r.key === resKey)!;
  const bin = assets.filter((a) => binFilter === "all" || a.kind === binFilter);
  const byTrack = (t: Track) => clips.filter((c) => c.track === t).sort((a, b) => a.start - b.start);
  const totalDur = Math.max(0.1, ...clips.map((c) => c.start + c.duration));
  const sel = clips.find((c) => c.id === selected) ?? null;
  const isActive = (c: EditClip, t: number) => t >= c.start && t < c.start + c.duration;

  // ── editing ──
  const addAsset = (a: EditorAsset) => {
    const track: Track = a.kind === "audio" ? "audio" : "video";
    const duration = a.duration ?? DEFAULTS[a.kind];
    const start = Math.max(0, ...clips.filter((c) => c.track === track).map((c) => c.start + c.duration));
    setClips((p) => [...p, { id: uid(), track, kind: a.kind, url: a.url, label: a.label, start, duration }]);
  };
  const addText = () => setClips((p) => [...p, { id: uid(), track: "text", kind: "text", text: "Your caption", label: "Text", start: +playheadRef.current.toFixed(2), duration: DEFAULTS.text }]);
  const update = (id: string, patch: Partial<EditClip>) => setClips((p) => p.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  const remove = (id: string) => { setClips((p) => p.filter((c) => c.id !== id)); setSelected(null); };

  // ── preview box sizing (contain) ──
  useEffect(() => {
    const c = containerRef.current;
    if (!c) return;
    const compute = () => {
      const cw = c.clientWidth, ch = c.clientHeight;
      if (cw < 2 || ch < 2) return;
      const ar = res.w / res.h;
      let w = cw, h = cw / ar;
      if (h > ch) { h = ch; w = ch * ar; }
      setPreviewSize({ w: Math.round(w), h: Math.round(h) });
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(c);
    return () => ro.disconnect();
  }, [res]);

  // ── playback engine (native media elements driven by a master clock) ──
  const syncMedia = useCallback((t: number) => {
    for (const c of clipsRef.current) {
      const el = mediaRefs.current.get(c.id);
      if (!el) continue;
      const active = isActive(c, t);
      if (active) {
        const local = t - c.start;
        if (Math.abs(el.currentTime - local) > 0.3) { try { el.currentTime = local; } catch { /* */ } }
        if (playingRef.current && el.paused) el.play().catch(() => {});
        if (!playingRef.current && !el.paused) el.pause();
      } else if (!el.paused) {
        el.pause();
      }
    }
  }, []);

  const stop = useCallback(() => {
    playingRef.current = false;
    setPlaying(false);
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    for (const el of mediaRefs.current.values()) { try { el.pause(); } catch { /* */ } }
  }, []);

  const loop = useCallback((now: number) => {
    const dt = (now - lastTsRef.current) / 1000;
    lastTsRef.current = now;
    let t = playheadRef.current + dt;
    const end = Math.max(0.1, ...clipsRef.current.map((c) => c.start + c.duration));
    if (t >= end) { t = end; playheadRef.current = t; setPlayhead(t); syncMedia(t); stop(); return; }
    playheadRef.current = t;
    setPlayhead(t);
    syncMedia(t);
    if (playingRef.current) rafRef.current = requestAnimationFrame(loop);
  }, [syncMedia, stop]);

  const play = useCallback(() => {
    if (playingRef.current) { stop(); return; }
    if (!clipsRef.current.length) return;
    const end = Math.max(0.1, ...clipsRef.current.map((c) => c.start + c.duration));
    if (playheadRef.current >= end) { playheadRef.current = 0; setPlayhead(0); }
    playingRef.current = true;
    setPlaying(true);
    lastTsRef.current = performance.now();
    syncMedia(playheadRef.current);
    rafRef.current = requestAnimationFrame(loop);
  }, [loop, stop, syncMedia]);

  const seek = useCallback((sec: number) => {
    const t = Math.max(0, sec);
    playheadRef.current = t;
    setPlayhead(t);
    syncMedia(t);
  }, [syncMedia]);

  useEffect(() => () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); }, []);

  const exportMp4 = () => setStatus("MP4-экспорт переводим на ffmpeg.wasm — следующим патчем (без ключей и водяного знака).");

  // ── clip drag/trim ──
  const dragRef = useRef<{ id: string; mode: "move" | "trim"; startX: number; origStart: number; origDur: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent, c: EditClip, mode: "move" | "trim") => {
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    dragRef.current = { id: c.id, mode, startX: e.clientX, origStart: c.start, origDur: c.duration };
    setSelected(c.id);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = (e.clientX - d.startX) / pxPerSec;
    if (d.mode === "move") update(d.id, { start: Math.max(0, +(d.origStart + dx).toFixed(2)) });
    else update(d.id, { duration: Math.max(MIN_DUR, +(d.origDur + dx).toFixed(2)) });
  };
  const onPointerUp = () => { dragRef.current = null; };

  const t = playhead;

  return (
    <div className="flex-1 flex min-h-0">
      {/* ── Asset bin ── */}
      <aside className="w-60 shrink-0 border-r border-border flex flex-col min-h-0">
        <div className="h-11 shrink-0 border-b border-border flex items-center gap-1 px-2 text-[11px]">
          {(["all", "video", "image", "audio"] as const).map((f) => (
            <button key={f} onClick={() => setBinFilter(f)}
              className={`px-2 py-1 rounded ${binFilter === f ? "bg-brand/15 text-brand" : "text-fg-muted hover:text-fg"}`}>{f}</button>
          ))}
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto p-2">
          <div className="grid grid-cols-2 gap-2">
            {bin.map((a) => (
              <button key={a.id} onClick={() => addAsset(a)} title={a.label}
                className="group relative aspect-square rounded-md overflow-hidden bg-bg-card border border-border hover:border-brand">
                {a.kind === "image" ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={a.url} alt="" className="absolute inset-0 w-full h-full object-cover" loading="lazy" />
                ) : a.kind === "video" ? (
                  <video src={a.url} muted playsInline preload="metadata" className="absolute inset-0 w-full h-full object-cover" />
                ) : (
                  <div className="absolute inset-0 flex items-center justify-center text-fg-subtle"><Music size={20} /></div>
                )}
                <span className="absolute top-1 left-1 px-1 rounded bg-black/60 text-[8px] uppercase text-white/80">{a.kind}</span>
                <span className="absolute inset-0 flex items-center justify-center bg-black/0 group-hover:bg-black/40 opacity-0 group-hover:opacity-100"><Plus size={18} className="text-white" /></span>
              </button>
            ))}
            {bin.length === 0 && <div className="col-span-2 text-fg-subtle text-[11px] p-3">No assets.</div>}
          </div>
        </div>
        <button onClick={addText} className="m-2 shrink-0 inline-flex items-center justify-center gap-1.5 py-2 rounded-md border border-border text-fg-muted hover:text-fg text-[12px]">
          <Type size={13} /> Add text
        </button>
      </aside>

      {/* ── Main ── */}
      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        {/* Toolbar */}
        <div className="h-11 shrink-0 border-b border-border flex items-center justify-between px-3 gap-2">
          <div className="flex items-center gap-2 text-fg text-[13px] font-medium"><Clapperboard size={14} className="text-brand" /> Editor</div>
          <div className="flex items-center gap-2">
            <select value={resKey} onChange={(e) => setResKey(e.target.value)} className="bg-bg-card border border-border rounded-md px-2 py-1 text-[11px] text-fg-muted outline-none">
              {RESOLUTIONS.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
            </select>
            <button onClick={exportMp4} disabled={!clips.length} className="px-3 py-1.5 rounded-md bg-brand text-black font-medium text-[12px] disabled:opacity-50 inline-flex items-center gap-1.5">
              <Download size={13} /> Export MP4
            </button>
          </div>
        </div>

        {/* Preview — native HTML5 player */}
        <div ref={containerRef} className="flex-1 min-h-0 bg-black flex items-center justify-center overflow-hidden relative">
          {clips.length > 0 ? (
            <div className="relative bg-black overflow-hidden" style={{ width: previewSize.w, height: previewSize.h }}>
              {clips.filter((c) => c.kind === "image").map((c) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img key={c.id} src={c.url} alt="" draggable={false}
                  className="absolute inset-0 w-full h-full object-contain"
                  style={{ opacity: isActive(c, t) ? 1 : 0 }} />
              ))}
              {clips.filter((c) => c.kind === "video").map((c) => (
                <video key={c.id} src={c.url} playsInline preload="auto"
                  ref={(el) => { if (el) mediaRefs.current.set(c.id, el); else mediaRefs.current.delete(c.id); }}
                  className="absolute inset-0 w-full h-full object-contain"
                  style={{ opacity: isActive(c, t) ? 1 : 0 }} />
              ))}
              {clips.filter((c) => c.kind === "audio").map((c) => (
                <audio key={c.id} src={c.url} preload="auto"
                  ref={(el) => { if (el) mediaRefs.current.set(c.id, el); else mediaRefs.current.delete(c.id); }} />
              ))}
              {clips.filter((c) => c.kind === "text" && isActive(c, t)).map((c) => (
                <div key={c.id} className="absolute inset-x-0 px-4 text-center font-bold text-white"
                  style={{ bottom: "12%", fontSize: Math.max(14, previewSize.w / 16), textShadow: "0 2px 8px #000, 0 0 4px #000" }}>
                  {c.text}
                </div>
              ))}
            </div>
          ) : (
            <div className="text-fg-subtle text-[12px]">Add assets from the left to start.</div>
          )}
        </div>

        {/* Transport */}
        <div className="h-9 shrink-0 border-t border-border flex items-center gap-3 px-3 text-[11px] text-fg-muted">
          <button onClick={() => seek(0)} className="hover:text-fg"><SkipBack size={14} /></button>
          <button onClick={play} className="text-fg hover:text-brand">{playing ? <Pause size={16} /> : <Play size={16} />}</button>
          <span className="tabular-nums">{fmt(playhead)} / {fmt(totalDur)}</span>
          <div className="ml-auto flex items-center gap-1.5">
            <button onClick={() => setPxPerSec((z) => Math.max(20, z - 20))} className="hover:text-fg"><ZoomOut size={13} /></button>
            <button onClick={() => setPxPerSec((z) => Math.min(200, z + 20))} className="hover:text-fg"><ZoomIn size={13} /></button>
          </div>
          {status && <span className="text-fg-subtle truncate max-w-[45%]">· {status}</span>}
        </div>

        {/* Timeline */}
        <div className="h-48 shrink-0 border-t border-border overflow-auto bg-bg-card/30 select-none"
          onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerLeave={onPointerUp}>
          <div style={{ width: Math.max(800, totalDur * pxPerSec + 120) }}>
            <div className="h-6 relative border-b border-border/60 ml-16 cursor-pointer" onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              seek((e.clientX - rect.left) / pxPerSec);
            }}>
              {Array.from({ length: Math.ceil(totalDur) + 1 }).map((_, s) => (
                <div key={s} className="absolute top-0 h-full border-l border-border/50 text-[8px] text-fg-subtle pl-1" style={{ left: s * pxPerSec }}>{s}s</div>
              ))}
              <div className="absolute top-0 bottom-0 w-0.5 bg-brand pointer-events-none z-20" style={{ left: playhead * pxPerSec }} />
            </div>

            {TRACKS.map((track) => (
              <div key={track} className="flex items-stretch border-b border-border/40 min-h-[48px]">
                <div className="w-16 shrink-0 flex items-center justify-center text-[9px] uppercase tracking-wider text-fg-subtle border-r border-border/40">{track}</div>
                <div className="relative flex-1 h-12">
                  <div className="absolute top-0 bottom-0 w-0.5 bg-brand/60 pointer-events-none z-20" style={{ left: playhead * pxPerSec }} />
                  {byTrack(track).map((c) => (
                    <div key={c.id}
                      onPointerDown={(e) => onPointerDown(e, c, "move")}
                      onClick={() => setSelected(c.id)}
                      style={{ left: c.start * pxPerSec, width: Math.max(24, c.duration * pxPerSec) }}
                      className={`absolute top-1.5 h-9 rounded px-2 text-[10px] leading-9 truncate cursor-grab active:cursor-grabbing border ${
                        selected === c.id ? "border-brand bg-brand/20 text-brand z-10" : "border-border bg-bg-card text-fg-muted"
                      }`}>
                      {c.kind === "text" ? (c.text || "Text") : c.label}
                      <span onPointerDown={(e) => onPointerDown(e, c, "trim")}
                        className="absolute right-0 top-0 h-full w-2 cursor-ew-resize bg-brand/40 rounded-r" />
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Inspector */}
        {sel && (
          <div className="shrink-0 border-t border-border p-2 flex items-center gap-3 text-[11px] flex-wrap">
            <span className="text-fg-subtle uppercase tracking-wider">{sel.kind}</span>
            {sel.kind === "text" && (
              <input value={sel.text ?? ""} onChange={(e) => update(sel.id, { text: e.target.value })}
                className="bg-bg-card border border-border rounded px-2 py-1 text-fg w-56 outline-none focus:border-brand" placeholder="Caption" />
            )}
            <label className="flex items-center gap-1 text-fg-muted">start
              <input type="number" min={0} step={0.1} value={sel.start} onChange={(e) => update(sel.id, { start: Math.max(0, Number(e.target.value) || 0) })}
                className="bg-bg-card border border-border rounded px-1.5 py-1 w-16 text-fg outline-none focus:border-brand" />s</label>
            <label className="flex items-center gap-1 text-fg-muted">dur
              <input type="number" min={MIN_DUR} step={0.1} value={sel.duration} onChange={(e) => update(sel.id, { duration: Math.max(MIN_DUR, Number(e.target.value) || MIN_DUR) })}
                className="bg-bg-card border border-border rounded px-1.5 py-1 w-16 text-fg outline-none focus:border-brand" />s</label>
            <button onClick={() => remove(sel.id)} className="text-red-400 hover:text-red-300 inline-flex items-center gap-1 ml-auto"><Trash2 size={13} /> delete</button>
          </div>
        )}
      </div>
    </div>
  );
}
