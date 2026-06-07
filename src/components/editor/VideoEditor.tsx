"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Music, Type, Plus, Trash2, Play, Pause, SkipBack,
  Download, Loader2, Clapperboard, ZoomIn, ZoomOut,
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
  start: number; // seconds on the timeline
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

// Engine loaded from CDN at runtime (WebCodecs lib — never bundled). See patch 92.
const ENGINE_CDN = "https://esm.sh/@diffusionstudio/core@4.0.3";
let _engine: Promise<any> | null = null;
function loadEngine(): Promise<any> {
  if (!_engine) {
    const dyn = new Function("u", "return import(u)") as (u: string) => Promise<any>;
    _engine = dyn(ENGINE_CDN);
  }
  return _engine;
}

let _id = 0;
const uid = () => `c${Date.now()}_${_id++}`;
const fmt = (s: number) => {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
};

export default function VideoEditor({ assets }: { assets: EditorAsset[] }) {
  const [clips, setClips] = useState<EditClip[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [binFilter, setBinFilter] = useState<"all" | "video" | "image" | "audio">("all");
  const [resKey, setResKey] = useState("9:16");
  const [pxPerSec, setPxPerSec] = useState(60);
  const [playing, setPlaying] = useState(false);
  const [playhead, setPlayhead] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement | null>(null); // bounded preview area
  const playerRef = useRef<HTMLDivElement | null>(null); // engine mounts canvas here
  const compRef = useRef<any>(null);
  const rafRef = useRef<number | null>(null);
  const dirtyRef = useRef(true); // composition needs rebuild
  const buildingRef = useRef(false); // prevents concurrent rebuilds
  const rebuildTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const res = RESOLUTIONS.find((r) => r.key === resKey)!;
  const bin = assets.filter((a) => binFilter === "all" || a.kind === binFilter);
  const byTrack = (t: Track) => clips.filter((c) => c.track === t).sort((a, b) => a.start - b.start);
  const totalDur = Math.max(1, ...clips.map((c) => c.start + c.duration));
  const sel = clips.find((c) => c.id === selected) ?? null;

  const markDirty = () => { dirtyRef.current = true; };
  const addAsset = (a: EditorAsset) => {
    const track: Track = a.kind === "audio" ? "audio" : "video";
    const duration = a.duration ?? DEFAULTS[a.kind];
    const start = Math.max(0, ...clips.filter((c) => c.track === track).map((c) => c.start + c.duration));
    setClips((p) => [...p, { id: uid(), track, kind: a.kind, url: a.url, label: a.label, start, duration }]);
    markDirty();
  };
  const addText = () => {
    setClips((p) => [...p, { id: uid(), track: "text", kind: "text", text: "Your caption", label: "Text", start: playhead, duration: DEFAULTS.text }]);
    markDirty();
  };
  const update = (id: string, patch: Partial<EditClip>) => {
    setClips((p) => p.map((c) => (c.id === id ? { ...c, ...patch } : c)));
    markDirty();
  };
  const remove = (id: string) => { setClips((p) => p.filter((c) => c.id !== id)); setSelected(null); markDirty(); };

  // ── build composition from clips ──
  const buildComposition = useCallback(async () => {
    const DS: any = await loadEngine();
    const comp = new DS.Composition({ width: res.w, height: res.h, background: "#000000" });

    for (const c of clips.filter((x) => x.track !== "text")) {
      try {
        const src = await DS.Source.from(c.url);
        const clip =
          c.kind === "video" ? new DS.VideoClip(src, { position: "center", height: "100%" })
          : c.kind === "image" ? new DS.ImageClip(src, { position: "center", height: "100%" })
          : new DS.AudioClip(src);
        try { clip.start = `${c.start}s`; } catch { /* */ }
        try { clip.duration = `${c.duration}s`; } catch { /* */ }
        await comp.add(clip);
      } catch (e) { console.error("[editor] clip failed", c, e); }
    }
    for (const c of clips.filter((x) => x.track === "text")) {
      try {
        const clip = new DS.TextClip({
          text: c.text ?? "", position: "center", align: "center", baseline: "middle",
          fontSize: Math.round(res.w / 16), fill: "#ffffff",
          stroke: { color: "#000000", width: 6 },
        });
        try { clip.start = `${c.start}s`; } catch { /* */ }
        try { clip.duration = `${c.duration}s`; } catch { /* */ }
        await comp.add(clip);
      } catch (e) { console.error("[editor] text failed", c, e); }
    }
    // composition duration is auto-computed from clips (no setter in 4.0.3)
    return comp;
  }, [clips, res, totalDur]);

  const fit = useCallback(() => {
    const c = containerRef.current, p = playerRef.current, comp = compRef.current;
    if (!c || !p || !comp) return;
    const cw = c.clientWidth, ch = c.clientHeight;
    if (cw < 2 || ch < 2) { requestAnimationFrame(fit); return; } // wait for layout
    const compW = comp.width || res.w, compH = comp.height || res.h;
    const scale = Math.min(cw / compW, ch / compH);
    p.style.position = "absolute";
    p.style.left = "50%";
    p.style.top = "50%";
    p.style.width = `${compW}px`;
    p.style.height = `${compH}px`;
    p.style.transformOrigin = "center";
    p.style.transform = `translate(-50%, -50%) scale(${scale})`;
  }, [res]);

  const rebuild = useCallback(async () => {
    if (!clips.length) return;
    if (buildingRef.current) return;
    buildingRef.current = true;
    setStatus("Building…");
    try {
      const old = compRef.current;
      try { old?.pause?.(); old?.unmount?.(playerRef.current); } catch { /* */ }
      const comp = await buildComposition();
      compRef.current = comp;
      if (playerRef.current) {
        playerRef.current.innerHTML = "";
        comp.mount(playerRef.current);
      }
      fit();
      await comp.seek?.(0);
      setPlayhead(0);
      dirtyRef.current = false;
      setStatus(null);
    } catch (e) {
      console.error(e);
      setStatus("Preview failed — see console.");
    } finally {
      buildingRef.current = false;
    }
  }, [clips.length, buildComposition, fit]);

  // refit on container resize
  useEffect(() => {
    const c = containerRef.current;
    if (!c) return;
    const ro = new ResizeObserver(() => fit());
    ro.observe(c);
    return () => ro.disconnect();
  }, [fit]);

  // debounced auto-rebuild after edits (keeps preview in sync)
  useEffect(() => {
    if (rebuildTimer.current) clearTimeout(rebuildTimer.current);
    rebuildTimer.current = setTimeout(() => { if (dirtyRef.current) rebuild(); }, 500);
    return () => { if (rebuildTimer.current) clearTimeout(rebuildTimer.current); };
  }, [clips, resKey, rebuild]);

  // playhead via RAF while playing (version-agnostic — reads currentTime)
  const tick = useCallback(() => {
    const comp = compRef.current;
    if (!comp) return;
    const t = typeof comp.currentTime === "number" ? comp.currentTime : 0;
    setPlayhead(t);
    if (comp.playing) rafRef.current = requestAnimationFrame(tick);
    else setPlaying(false);
  }, []);

  const play = useCallback(async () => {
    let comp = compRef.current;
    if (!comp || dirtyRef.current) { await rebuild(); comp = compRef.current; }
    if (!comp) return;
    try {
      if (playing || comp.playing) {
        await comp.pause(); setPlaying(false);
        if (rafRef.current) cancelAnimationFrame(rafRef.current);
      } else {
        await comp.play(); setPlaying(true);
        rafRef.current = requestAnimationFrame(tick);
      }
    } catch (e) { console.error(e); }
  }, [playing, rebuild, tick]);

  const seek = useCallback(async (sec: number) => {
    setPlayhead(Math.max(0, sec));
    try { await compRef.current?.seek?.(Math.max(0, sec)); } catch { /* */ }
  }, []);

  const exportMp4 = useCallback(async () => {
    if (exporting || !clips.length) return;
    setExporting(true); setProgress(0); setStatus("Rendering MP4…");
    try {
      const DS: any = await loadEngine();
      const comp = await buildComposition();
      const enc = new DS.Encoder(comp);
      try { enc.on?.("render", (e: any) => { const d = e?.detail; if (d?.total) setProgress(Math.round((d.progress * 100) / d.total)); }); } catch { /* */ }
      const result = await enc.render();
      const blob: Blob = result instanceof Blob ? result : (result?.blob ?? result);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `flowlab-${Date.now()}.mp4`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
      setStatus("Done — MP4 downloaded.");
    } catch (e) { console.error(e); setStatus("Export failed — see console."); }
    finally { setExporting(false); }
  }, [exporting, clips.length, buildComposition]);

  // ── clip drag/trim on the timeline ──
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
            <select value={resKey} onChange={(e) => { setResKey(e.target.value); markDirty(); }} className="bg-bg-card border border-border rounded-md px-2 py-1 text-[11px] text-fg-muted outline-none">
              {RESOLUTIONS.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
            </select>
            <button onClick={exportMp4} disabled={exporting || !clips.length} className="px-3 py-1.5 rounded-md bg-brand text-black font-medium text-[12px] disabled:opacity-50 inline-flex items-center gap-1.5">
              {exporting ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}{exporting ? `${progress}%` : "Export MP4"}
            </button>
          </div>
        </div>

        {/* Preview (bounded; canvas scaled to fit) */}
        <div ref={containerRef} className="flex-1 min-h-0 bg-black flex items-center justify-center overflow-hidden relative">
          <div ref={playerRef} />
          {!clips.length && <div className="absolute text-fg-subtle text-[12px]">Add assets from the left to start.</div>}
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
          {status && <span className="text-fg-subtle truncate max-w-[40%]">· {status}</span>}
        </div>

        {/* Timeline */}
        <div className="h-48 shrink-0 border-t border-border overflow-auto bg-bg-card/30 select-none"
          onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerLeave={onPointerUp}>
          <div style={{ width: Math.max(800, totalDur * pxPerSec + 120) }}>
            {/* Ruler */}
            <div className="h-6 relative border-b border-border/60 ml-16 cursor-pointer" onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              seek((e.clientX - rect.left) / pxPerSec);
            }}>
              {Array.from({ length: Math.ceil(totalDur) + 1 }).map((_, s) => (
                <div key={s} className="absolute top-0 h-full border-l border-border/50 text-[8px] text-fg-subtle pl-1" style={{ left: s * pxPerSec }}>{s}s</div>
              ))}
              <div className="absolute top-0 bottom-0 w-0.5 bg-brand pointer-events-none z-20" style={{ left: playhead * pxPerSec }} />
            </div>

            {/* Tracks */}
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
