"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { alphaAt, clipVisual, TRANSITIONS, type CompClip } from "@/lib/editor/compositor";
import {
  Music, Type, Plus, Trash2, Play, Pause, SkipBack,
  Download, Clapperboard, ZoomIn, ZoomOut, Loader2, Sparkles, Copy, Wand2,
} from "lucide-react";

export type EditorAsset = {
  id: string;
  url: string;
  kind: "video" | "image" | "audio";
  label: string;
  duration: number | null;
};

type LayerType = "visual" | "audio";
type Layer = { id: string; name: string; type: LayerType };
type Kind = "video" | "image" | "audio" | "text" | "fx" | "adjust";
type EditClip = {
  id: string;
  layer: string;
  kind: Kind;
  url?: string;
  text?: string;
  label: string;
  start: number;
  duration: number;
  scale: number;
  x: number;
  y: number;
  fadeIn: number;
  fadeOut: number;
  anim?: string;
  fx?: string;
  transType?: string;
};

const RESOLUTIONS = [
  { key: "9:16", label: "Portrait 9:16", w: 1080, h: 1920 },
  { key: "4:5", label: "Portrait 4:5", w: 1080, h: 1350 },
  { key: "16:9", label: "Landscape 16:9", w: 1920, h: 1080 },
  { key: "1:1", label: "Square 1:1", w: 1080, h: 1080 },
];
const DEFAULTS = { image: 4, audio: 6, video: 4, text: 3, fx: 1.5, adjust: 3 };
const MIN_DUR = 0.3;
const ANIMS = [
  { v: "", l: "None" }, { v: "kenBurns", l: "Ken Burns" }, { v: "zoomIn", l: "Zoom In" },
  { v: "zoomOut", l: "Zoom Out" }, { v: "slideL", l: "Slide ←" }, { v: "slideR", l: "Slide →" },
  { v: "pulse", l: "Pulse" }, { v: "shake", l: "Shake" }, { v: "panLeft", l: "Pan ←" },
  { v: "panRight", l: "Pan →" }, { v: "drift", l: "Drift" }, { v: "breathe", l: "Breathe" },
];
const FX = [
  { v: "vignette", l: "Vignette" }, { v: "flash", l: "Flash" }, { v: "fadeBlack", l: "Fade black" },
  { v: "tint", l: "Warm tint" }, { v: "coolTint", l: "Cool tint" }, { v: "blackbars", l: "Cinematic bars" },
];
const ADJUST = [
  { v: "grayscale(1)", l: "B&W" }, { v: "sepia(0.8)", l: "Sepia" }, { v: "invert(1)", l: "Invert" },
  { v: "blur(6px)", l: "Blur" }, { v: "brightness(1.35)", l: "Bright" }, { v: "brightness(0.6)", l: "Dark" },
  { v: "contrast(1.5)", l: "Contrast" }, { v: "saturate(1.9)", l: "Saturate" }, { v: "hue-rotate(90deg)", l: "Hue shift" },
  { v: "sepia(0.4) contrast(1.2) saturate(1.3)", l: "Vintage" }, { v: "hue-rotate(-20deg) saturate(1.3)", l: "Cool" },
  { v: "sepia(0.3) saturate(1.2) brightness(1.05)", l: "Warm" }, { v: "contrast(1.5) brightness(0.9) saturate(1.2)", l: "Dramatic" },
  { v: "contrast(0.85) brightness(1.1) saturate(0.9)", l: "Faded" },
];

let _id = 0, _l = 0;
const uid = () => `c${Date.now()}_${_id++}`;
const fmt = (s: number) => `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, "0")}`;

export default function VideoEditor({ assets }: { assets: EditorAsset[] }) {
  const [layers, setLayers] = useState<Layer[]>([{ id: "v1", name: "V1", type: "visual" }, { id: "a1", name: "A1", type: "audio" }]);
  const [clips, setClips] = useState<EditClip[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [binFilter, setBinFilter] = useState<"all" | "video" | "image" | "audio">("all");
  const [resKey, setResKey] = useState("9:16");
  const [pxPerSec, setPxPerSec] = useState(60);
  const [playing, setPlaying] = useState(false);
  const [playhead, setPlayhead] = useState(0);
  const [previewSize, setPreviewSize] = useState({ w: 0, h: 0 });
  const [status, setStatus] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const [dropHint, setDropHint] = useState<{ type: "lane" | "strip"; id: string } | null>(null);
  const [panelTab, setPanelTab] = useState<"media" | "effects" | "filters" | "text">("media");
  const [transMenu, setTransMenu] = useState<{ x: number; y: number; id: string } | null>(null);

  const laneRefs = useRef<Map<string, HTMLElement>>(new Map());
  const stripRefs = useRef<Map<string, HTMLElement>>(new Map());
  const dropHintRef = useRef<typeof dropHint>(null);
  dropHintRef.current = dropHint;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const mediaRefs = useRef<Map<string, HTMLVideoElement | HTMLAudioElement>>(new Map());
  const rafRef = useRef<number | null>(null);
  const lastTsRef = useRef(0);
  const playingRef = useRef(false);
  const playheadRef = useRef(0);
  const clipsRef = useRef<EditClip[]>([]);
  const selectedRef = useRef<string | null>(null);
  clipsRef.current = clips;
  selectedRef.current = selected;

  const res = RESOLUTIONS.find((r) => r.key === resKey)!;
  const bin = assets.filter((a) => binFilter === "all" || a.kind === binFilter);
  const visualLayers = layers.filter((l) => l.type === "visual");
  const topVisualId = () => visualLayers[0]?.id ?? "v1";
  const firstAudioId = () => layers.find((l) => l.type === "audio")?.id ?? "a1";
  const onLayer = (id: string) => clips.filter((c) => c.layer === id).sort((a, b) => a.start - b.start);
  const totalDur = Math.max(0.1, ...clips.map((c) => c.start + c.duration));
  const sel = clips.find((c) => c.id === selected) ?? null;
  const isActive = (c: EditClip, tt: number) => tt >= c.start && tt < c.start + c.duration;
  const endOf = (cl: EditClip[]) => Math.max(0.1, ...cl.map((c) => c.start + c.duration));

  const base = (kind: Kind, layer: string, url: string | undefined, label: string, start: number, duration: number, extra: Partial<EditClip> = {}): EditClip =>
    ({ id: uid(), layer, kind, url, label, start, duration, scale: 1, x: 0, y: 0, fadeIn: 0, fadeOut: 0, ...extra });
  const addAssetAt = (a: { kind: EditorAsset["kind"]; url: string; label: string; duration: number | null }, layerId?: string, start?: number) => {
    const layer = layerId ?? (a.kind === "audio" ? firstAudioId() : topVisualId());
    const duration = a.duration ?? DEFAULTS[a.kind];
    const at = start ?? Math.max(0, ...clips.filter((c) => c.layer === layer).map((c) => c.start + c.duration));
    setClips((p) => [...p, base(a.kind, layer, a.url, a.label, Math.max(0, at), duration)]);
  };
  const addOnNewTop = (kind: Kind, extra: Partial<EditClip>, dur: number, label: string) => {
    const id = createLayerAt(0, "visual");
    setClips((p) => [...p, base(kind, id, undefined, label, +playheadRef.current.toFixed(2), dur, extra)]);
  };
  const addText = () => addOnNewTop("text", { text: "Your caption" }, DEFAULTS.text, "Text");
  const addFx = (type = "vignette") => addOnNewTop("fx", { fx: type }, DEFAULTS.fx, "FX");
  const addAdjust = (v = "grayscale(1)") => addOnNewTop("adjust", { fx: v }, DEFAULTS.adjust, "Adjust");
  const update = (id: string, patch: Partial<EditClip>) => setClips((p) => p.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  const remove = useCallback((id: string) => { setClips((p) => p.filter((c) => c.id !== id)); setSelected((s) => (s === id ? null : s)); }, []);
  const duplicate = (id: string) => setClips((p) => { const c = p.find((x) => x.id === id); return c ? [...p, { ...c, id: uid(), start: c.start + 0.3 }] : p; });
  const layerType = (c: { kind: Kind }): LayerType => (c.kind === "audio" ? "audio" : "visual");
  const createLayerAt = (index: number, type: LayerType): string => {
    const id = `${type === "visual" ? "v" : "a"}${Date.now()}_${_l++}`;
    const name = `${type === "visual" ? "V" : "A"}${layers.filter((l) => l.type === type).length + 1}`;
    setLayers((p) => { const n = [...p]; n.splice(Math.max(0, Math.min(index, n.length)), 0, { id, name, type }); return n; });
    return id;
  };
  // auto-prune empty layers (keep ≥1 visual and ≥1 audio) — tracks appear/disappear like CapCut
  useEffect(() => {
    setLayers((prev) => {
      const used = new Set(clips.map((c) => c.layer));
      const next = prev.filter((l) => used.has(l.id));
      if (!next.some((l) => l.type === "visual")) { const v = prev.find((l) => l.type === "visual"); if (v) next.unshift(v); }
      if (!next.some((l) => l.type === "audio")) { const a = prev.find((l) => l.type === "audio"); if (a) next.push(a); }
      return next.length === prev.length ? prev : next;
    });
  }, [clips]);

  useEffect(() => {
    const c = containerRef.current; if (!c) return;
    const compute = () => {
      const cw = c.clientWidth, ch = c.clientHeight; if (cw < 2 || ch < 2) return;
      const ar = res.w / res.h; let w = cw, h = cw / ar; if (h > ch) { h = ch; w = ch * ar; }
      setPreviewSize({ w: Math.round(w), h: Math.round(h) });
    };
    compute(); const ro = new ResizeObserver(compute); ro.observe(c); return () => ro.disconnect();
  }, [res]);

  const syncMedia = useCallback((tt: number) => {
    for (const c of clipsRef.current) {
      const el = mediaRefs.current.get(c.id); if (!el) continue;
      const active = tt >= c.start && tt < c.start + c.duration;
      if (active) {
        const local = tt - c.start;
        if (Math.abs(el.currentTime - local) > 0.3) { try { el.currentTime = local; } catch { /* */ } }
        try { el.volume = alphaAt(c, tt); } catch { /* */ }
        if (playingRef.current && el.paused) el.play().catch(() => {});
        if (!playingRef.current && !el.paused) el.pause();
      } else if (!el.paused) el.pause();
    }
  }, []);
  const stop = useCallback(() => {
    playingRef.current = false; setPlaying(false);
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    for (const el of mediaRefs.current.values()) { try { el.pause(); } catch { /* */ } }
  }, []);
  const loop = useCallback((now: number) => {
    const dt = (now - lastTsRef.current) / 1000; lastTsRef.current = now;
    let tt = playheadRef.current + dt; const end = endOf(clipsRef.current);
    if (tt >= end) { tt = end; playheadRef.current = tt; setPlayhead(tt); syncMedia(tt); stop(); return; }
    playheadRef.current = tt; setPlayhead(tt); syncMedia(tt);
    if (playingRef.current) rafRef.current = requestAnimationFrame(loop);
  }, [syncMedia, stop]);
  const play = useCallback(() => {
    if (playingRef.current) { stop(); return; }
    if (!clipsRef.current.length) return;
    if (playheadRef.current >= endOf(clipsRef.current)) { playheadRef.current = 0; setPlayhead(0); }
    playingRef.current = true; setPlaying(true); lastTsRef.current = performance.now();
    syncMedia(playheadRef.current); rafRef.current = requestAnimationFrame(loop);
  }, [loop, stop, syncMedia]);
  const seek = useCallback((sec: number) => { const tt = Math.max(0, sec); playheadRef.current = tt; setPlayhead(tt); syncMedia(tt); }, [syncMedia]);
  useEffect(() => () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tg = e.target as HTMLElement | null;
      if (tg && (tg.tagName === "INPUT" || tg.tagName === "TEXTAREA" || tg.tagName === "SELECT" || tg.isContentEditable)) return;
      if (e.code === "Space") { e.preventDefault(); play(); }
      else if (e.key === "Delete" || e.key === "Backspace") { if (selectedRef.current) { e.preventDefault(); remove(selectedRef.current); } }
    };
    window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey);
  }, [play, remove]);

  useEffect(() => {
    if (!menu && !transMenu) return;
    const close = () => { setMenu(null); setTransMenu(null); };
    window.addEventListener("click", close); window.addEventListener("scroll", close, true); window.addEventListener("resize", close);
    return () => { window.removeEventListener("click", close); window.removeEventListener("scroll", close, true); window.removeEventListener("resize", close); };
  }, [menu, transMenu]);

  const exportMp4 = useCallback(async () => {
    if (exporting || !clips.length) return;
    setExporting(true); setProgress(0); setStatus("Recording…"); stop();
    try {
      const vis = layers.filter((l) => l.type === "visual");
      const z: EditClip[] = [];
      for (let i = vis.length - 1; i >= 0; i--) z.push(...clips.filter((c) => c.layer === vis[i].id).sort((a, b) => a.start - b.start));
      const ordered = [...z, ...clips.filter((c) => !z.includes(c))];
      const { exportTimeline } = await import("@/lib/editor/exportVideo");
      const { blob, ext, mp4 } = await exportTimeline({
        clips: ordered.map((c) => ({ id: c.id, layer: c.layer, kind: c.kind, url: c.url, text: c.text, start: c.start, duration: c.duration, scale: c.scale, x: c.x, y: c.y, fadeIn: c.fadeIn, fadeOut: c.fadeOut, anim: c.anim, fx: c.fx, transType: c.transType })),
        width: res.w, height: res.h, previewWidth: previewSize.w,
        onProgress: (p) => setProgress(Math.round(p * 100)),
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url; a.download = `flowlab-${Date.now()}.${ext}`;
      document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
      setStatus(mp4 ? "Done — MP4 downloaded." : "Done — WebM downloaded (browser doesn\u2019t support MP4 recording).");
    } catch (e) { console.error(e); setStatus(`Export failed: ${e instanceof Error ? e.message : "see console"}`); }
    finally { setExporting(false); }
  }, [exporting, clips, layers, res, previewSize, stop]);

  const dragRef = useRef<{ id: string; mode: "move" | "trim"; startX: number; origStart: number; origDur: number; type: LayerType } | null>(null);
  const hitTest = (clientY: number, type: LayerType): { type: "lane" | "strip"; id: string } | null => {
    for (const [id, el] of stripRefs.current) { const r = el.getBoundingClientRect(); if (clientY >= r.top - 3 && clientY <= r.bottom + 3) return { type: "strip", id }; }
    for (const [id, el] of laneRefs.current) { const r = el.getBoundingClientRect(); if (clientY >= r.top && clientY <= r.bottom) { const lane = layers.find((l) => l.id === id); return lane && lane.type === type ? { type: "lane", id } : null; } }
    return null;
  };
  const onClipPointerDown = (e: React.PointerEvent, c: EditClip, mode: "move" | "trim") => {
    e.stopPropagation(); (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    dragRef.current = { id: c.id, mode, startX: e.clientX, origStart: c.start, origDur: c.duration, type: layerType(c) }; setSelected(c.id);
  };
  const onClipPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current; if (!d) return; const dx = (e.clientX - d.startX) / pxPerSec;
    if (d.mode === "move") { update(d.id, { start: Math.max(0, +(d.origStart + dx).toFixed(2)) }); setDropHint(hitTest(e.clientY, d.type)); }
    else update(d.id, { duration: Math.max(MIN_DUR, +(d.origDur + dx).toFixed(2)) });
  };
  const onClipPointerUp = () => {
    const d = dragRef.current; dragRef.current = null;
    const hint = dropHintRef.current; setDropHint(null);
    if (!d || d.mode !== "move" || !hint) return;
    const clip = clipsRef.current.find((c) => c.id === d.id); if (!clip) return;
    if (hint.type === "lane") { if (hint.id !== clip.layer) update(d.id, { layer: hint.id }); }
    else { const index = Number(hint.id.split("-")[1]); const id = createLayerAt(index, d.type); update(d.id, { layer: id }); }
  };

  const scrubRef = useRef(false);
  const seekFromRuler = (clientX: number, el: HTMLElement) => { const r = el.getBoundingClientRect(); seek((clientX - r.left) / pxPerSec); };
  const onRulerDown = (e: React.PointerEvent) => { scrubRef.current = true; (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId); if (playingRef.current) stop(); seekFromRuler(e.clientX, e.currentTarget as HTMLElement); };
  const onRulerMove = (e: React.PointerEvent) => { if (scrubRef.current) seekFromRuler(e.clientX, e.currentTarget as HTMLElement); };
  const onRulerUp = () => { scrubRef.current = false; };

  const vpRef = useRef<{ id: string; mode: "move" | "scale"; sx: number; sy: number; ox: number; oy: number; os: number } | null>(null);
  const onVpDown = (e: React.PointerEvent, c: EditClip, mode: "move" | "scale") => {
    e.stopPropagation(); setSelected(c.id);
    vpRef.current = { id: c.id, mode, sx: e.clientX, sy: e.clientY, ox: c.x, oy: c.y, os: c.scale };
  };
  const onVpMove = (e: React.PointerEvent) => {
    const d = vpRef.current; if (!d) return; const dx = e.clientX - d.sx, dy = e.clientY - d.sy;
    if (d.mode === "move") update(d.id, { x: Math.round(d.ox + dx), y: Math.round(d.oy + dy) });
    else update(d.id, { scale: Math.min(5, Math.max(0.2, +(d.os + (dx + dy) / 250).toFixed(2))) });
  };
  const onVpUp = () => { vpRef.current = null; };

  const onBinDragStart = (e: React.DragEvent, a: EditorAsset) => {
    e.dataTransfer.setData("application/x-flowlab-asset", JSON.stringify({ kind: a.kind, url: a.url, label: a.label, duration: a.duration }));
    e.dataTransfer.effectAllowed = "copy";
  };
  const onLaneDrop = (e: React.DragEvent, layer: Layer) => {
    e.preventDefault(); setDropHint(null);
    const raw = e.dataTransfer.getData("application/x-flowlab-asset"); if (!raw) return;
    const a = JSON.parse(raw) as { kind: EditorAsset["kind"]; url: string; label: string; duration: number | null };
    if ((a.kind === "audio" ? "audio" : "visual") !== layer.type) return;
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    addAssetAt(a, layer.id, Math.max(0, (e.clientX - r.left) / pxPerSec));
  };
  const onStripDrop = (e: React.DragEvent, index: number) => {
    e.preventDefault(); setDropHint(null);
    const raw = e.dataTransfer.getData("application/x-flowlab-asset"); if (!raw) return;
    const a = JSON.parse(raw) as { kind: EditorAsset["kind"]; url: string; label: string; duration: number | null };
    const id = createLayerAt(index, a.kind === "audio" ? "audio" : "visual");
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    addAssetAt(a, id, Math.max(0, (e.clientX - r.left) / pxPerSec));
  };

  const onClipContext = (e: React.MouseEvent, c: EditClip) => { e.preventDefault(); e.stopPropagation(); setSelected(c.id); setMenu({ x: e.clientX, y: e.clientY, id: c.id }); };

  // transition applied via the "+" between two adjacent clips (CapCut-style)
  const applyTransition = (bId: string, v: string) => {
    const b = clipsRef.current.find((c) => c.id === bId); if (!b) return;
    const prev = clipsRef.current.filter((c) => c.layer === b.layer && (c.kind === "video" || c.kind === "image" || c.kind === "text") && c.start < b.start).sort((p, q) => q.start - p.start)[0];
    const patch: Partial<EditClip> = { transType: v };
    if (v && prev) { const ns = +(prev.start + prev.duration - 0.5).toFixed(2); if (ns >= 0 && ns < b.start) patch.start = ns; }
    update(bId, patch); setTransMenu(null);
  };

  const t = playhead;
  const styleFromVisual = (c: EditClip, v: ReturnType<typeof clipVisual>): React.CSSProperties => {
    const tx = (c.x || 0) + v.offX * previewSize.w;
    const ty = (c.y || 0) + v.offY * previewSize.h;
    return {
      opacity: v.opacity,
      transform: `translate(${tx}px, ${ty}px) scale(${(c.scale || 1) * v.scaleMul})`,
      transformOrigin: "center",
      clipPath: v.reveal != null ? `inset(0 ${Math.round((1 - v.reveal) * 100)}% 0 0)` : undefined,
    };
  };
  const fxStyle = (kind?: string): React.CSSProperties =>
    kind === "flash" ? { background: "#fff" }
    : kind === "fadeBlack" ? { background: "#000" }
    : kind === "tint" ? { background: "rgba(255,120,40,0.25)" }
    : kind === "coolTint" ? { background: "rgba(40,120,255,0.22)" }
    : kind === "blackbars" ? { background: "linear-gradient(to bottom, #000 0, #000 12%, transparent 12%, transparent 88%, #000 88%, #000 100%)" }
    : { background: "radial-gradient(ellipse at center, rgba(0,0,0,0) 40%, rgba(0,0,0,0.78) 100%)" };

  // z-order (bottom → top) of all visual-layer clips
  const zClips: EditClip[] = [];
  for (let i = visualLayers.length - 1; i >= 0; i--) zClips.push(...onLayer(visualLayers[i].id));

  return (
    <div className="flex-1 flex min-h-0">
      {/* Library panel */}
      <aside className="w-60 shrink-0 border-r border-border flex flex-col min-h-0">
        <div className="h-11 shrink-0 border-b border-border flex items-center gap-1 px-2 text-[11px]">
          {([["media", "Media"], ["effects", "Effects"], ["filters", "Filters"], ["text", "Text"]] as const).map(([k, l]) => (
            <button key={k} onClick={() => setPanelTab(k)} className={`px-2 py-1 rounded ${panelTab === k ? "bg-brand/15 text-brand" : "text-fg-muted hover:text-fg"}`}>{l}</button>
          ))}
        </div>

        {panelTab === "media" && (
          <>
            <div className="shrink-0 flex items-center gap-1 px-2 py-1.5 text-[10px] border-b border-border/50">
              {(["all", "video", "image", "audio"] as const).map((f) => (
                <button key={f} onClick={() => setBinFilter(f)} className={`px-2 py-0.5 rounded ${binFilter === f ? "bg-brand/15 text-brand" : "text-fg-subtle hover:text-fg"}`}>{f}</button>
              ))}
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto p-2">
              <div className="grid grid-cols-2 gap-2">
                {bin.map((a) => (
                  <button key={a.id} draggable onDragStart={(e) => onBinDragStart(e, a)} onClick={() => addAssetAt(a)} title={a.label}
                    className="group relative aspect-square rounded-md overflow-hidden bg-bg-card border border-border hover:border-brand cursor-grab active:cursor-grabbing">
                    {a.kind === "image" ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={a.url} alt="" className="absolute inset-0 w-full h-full object-cover" loading="lazy" draggable={false} />
                    ) : a.kind === "video" ? (
                      <video src={a.url} muted playsInline preload="metadata" className="absolute inset-0 w-full h-full object-cover" />
                    ) : (<div className="absolute inset-0 flex items-center justify-center text-fg-subtle"><Music size={20} /></div>)}
                    <span className="absolute top-1 left-1 px-1 rounded bg-black/60 text-[8px] uppercase text-white/80">{a.kind}</span>
                    <span className="absolute inset-0 flex items-center justify-center bg-black/0 group-hover:bg-black/40 opacity-0 group-hover:opacity-100"><Plus size={18} className="text-white" /></span>
                  </button>
                ))}
                {bin.length === 0 && <div className="col-span-2 text-fg-subtle text-[11px] p-3">No assets.</div>}
              </div>
            </div>
          </>
        )}

        {panelTab === "effects" && (
          <div className="flex-1 min-h-0 overflow-y-auto p-2">
            <div className="text-[10px] text-fg-subtle px-1 pb-2">Overlay effect — added as a clip on a new top layer.</div>
            <div className="grid grid-cols-2 gap-2">
              {FX.map((f) => (
                <button key={f.v} onClick={() => addFx(f.v)} className="relative aspect-video rounded-md overflow-hidden border border-border hover:border-brand bg-black flex items-end justify-center group">
                  <div className="absolute inset-0" style={fxStyle(f.v)} />
                  <span className="relative z-10 text-[10px] text-white font-medium pb-1 inline-flex items-center gap-1"><Sparkles size={11} /> {f.l}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {panelTab === "filters" && (
          <div className="flex-1 min-h-0 overflow-y-auto p-2">
            <div className="text-[10px] text-fg-subtle px-1 pb-2">Filter — added as a clip; affects only layers below it.</div>
            <div className="grid grid-cols-2 gap-2">
              {ADJUST.map((f) => (
                <button key={f.v} onClick={() => addAdjust(f.v)} className="relative aspect-video rounded-md overflow-hidden border border-border hover:border-brand bg-gradient-to-br from-bg-card to-bg-card/40 flex items-end justify-center">
                  <div className="absolute inset-0 bg-gradient-to-br from-cyan-400/30 via-fuchsia-400/20 to-amber-300/30" style={{ filter: f.v }} />
                  <span className="relative z-10 text-[10px] text-white font-medium pb-1 inline-flex items-center gap-1"><Wand2 size={11} /> {f.l}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {panelTab === "text" && (
          <div className="flex-1 min-h-0 overflow-y-auto p-2">
            <button onClick={addText} className="w-full inline-flex items-center justify-center gap-1.5 py-2.5 rounded-md border border-border text-fg-muted hover:text-fg hover:border-brand text-[12px]"><Type size={13} /> Add text</button>
            <div className="text-[10px] text-fg-subtle px-1 pt-2">Adds a caption on a new top layer; edit text in the inspector.</div>
          </div>
        )}
      </aside>

      {/* Main */}
      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        <div className="h-11 shrink-0 border-b border-border flex items-center justify-between px-3 gap-2">
          <div className="flex items-center gap-2 text-fg text-[13px] font-medium"><Clapperboard size={14} className="text-brand" /> Editor</div>
          <div className="flex items-center gap-2">
            <select value={resKey} onChange={(e) => setResKey(e.target.value)} className="bg-bg-card border border-border rounded-md px-2 py-1 text-[11px] text-fg-muted outline-none">
              {RESOLUTIONS.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
            </select>
            <button onClick={exportMp4} disabled={exporting || !clips.length} className="px-3 py-1.5 rounded-md bg-brand text-black font-medium text-[12px] disabled:opacity-50 inline-flex items-center gap-1.5">
              {exporting ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}{exporting ? `${progress}%` : "Export MP4"}
            </button>
          </div>
        </div>

        {/* Preview */}
        <div ref={containerRef} className="flex-1 min-h-0 bg-black flex items-center justify-center overflow-hidden relative">
          {clips.length > 0 ? (
            <div className="relative bg-black overflow-hidden ring-1 ring-white/20" style={{ width: previewSize.w, height: previewSize.h }}
              onPointerMove={onVpMove} onPointerUp={onVpUp} onPointerLeave={onVpUp}>
              <div className="absolute inset-0">
                {zClips.map((c) => {
                  if (c.kind === "fx") return isActive(c, t)
                    ? <div key={c.id} className="absolute inset-0 pointer-events-none" style={{ ...fxStyle(c.fx), opacity: alphaAt(c, t) || 1 }} />
                    : null;
                  if (c.kind === "adjust") return isActive(c, t) && c.fx
                    ? <div key={c.id} className="absolute inset-0 pointer-events-none" style={{ backdropFilter: c.fx, WebkitBackdropFilter: c.fx as string, opacity: alphaAt(c, t) || 1 }} />
                    : null;
                  const active = isActive(c, t);
                  const isSel = selected === c.id;
                  const v = clipVisual(c as CompClip, t, clips as CompClip[]);
                  return (
                    <div key={c.id} className="absolute inset-0"
                      style={{ ...styleFromVisual(c, v), pointerEvents: active ? "auto" : "none", cursor: "move", touchAction: "none" }}
                      onPointerDown={(e) => onVpDown(e, c, "move")} onContextMenu={(e) => onClipContext(e, c)}>
                      {c.kind === "image" && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={c.url} alt="" draggable={false} className="absolute inset-0 w-full h-full object-contain pointer-events-none" />
                      )}
                      {c.kind === "video" && (
                        <video src={c.url} playsInline preload="auto" ref={(el) => { if (el) mediaRefs.current.set(c.id, el); else mediaRefs.current.delete(c.id); }}
                          className="absolute inset-0 w-full h-full object-contain pointer-events-none" />
                      )}
                      {c.kind === "text" && (
                        <div className="absolute inset-x-0 px-4 text-center font-bold text-white pointer-events-none"
                          style={{ bottom: "12%", fontSize: Math.max(14, previewSize.w / 16), textShadow: "0 2px 8px #000, 0 0 4px #000" }}>{c.text}</div>
                      )}
                      {isSel && active && (<><div className="absolute inset-0 ring-2 ring-brand pointer-events-none" />
                        <div onPointerDown={(e) => onVpDown(e, c, "scale")} className="absolute bottom-1 right-1 w-3.5 h-3.5 bg-brand rounded-sm cursor-nwse-resize" style={{ touchAction: "none" }} /></>)}
                    </div>
                  );
                })}
              </div>
              {clips.filter((c) => c.kind === "audio").map((c) => (
                <audio key={c.id} src={c.url} preload="auto" ref={(el) => { if (el) mediaRefs.current.set(c.id, el); else mediaRefs.current.delete(c.id); }} />
              ))}
              <div className="absolute inset-[5%] border border-white/10 pointer-events-none" />
            </div>
          ) : (<div className="text-fg-subtle text-[12px]">Add or drag assets from the left to start.</div>)}
        </div>

        {/* Transport */}
        <div className="h-9 shrink-0 border-t border-border flex items-center gap-3 px-3 text-[11px] text-fg-muted">
          <button onClick={() => seek(0)} className="hover:text-fg"><SkipBack size={14} /></button>
          <button onClick={play} className="text-fg hover:text-brand">{playing ? <Pause size={16} /> : <Play size={16} />}</button>
          <span className="tabular-nums">{fmt(playhead)} / {fmt(totalDur)}</span>
          <div className="ml-auto flex items-center gap-2">
            <button onClick={() => setPxPerSec((z) => Math.max(20, z - 20))} className="hover:text-fg"><ZoomOut size={13} /></button>
            <button onClick={() => setPxPerSec((z) => Math.min(200, z + 20))} className="hover:text-fg"><ZoomIn size={13} /></button>
          </div>
          {status && <span className="text-fg-subtle truncate max-w-[35%]">· {status}</span>}
        </div>

        {/* Timeline */}
        <div className="h-52 shrink-0 border-t border-border overflow-auto bg-bg-card/30 select-none"
          onPointerMove={onClipPointerMove} onPointerUp={onClipPointerUp} onPointerLeave={onClipPointerUp}>
          <div style={{ width: Math.max(800, totalDur * pxPerSec + 120) }}>
            <div className="h-6 relative border-b border-border/60 ml-20 cursor-ew-resize touch-none" onPointerDown={onRulerDown} onPointerMove={onRulerMove} onPointerUp={onRulerUp}>
              {Array.from({ length: Math.ceil(totalDur) + 1 }).map((_, s) => (
                <div key={s} className="absolute top-0 h-full border-l border-border/50 text-[8px] text-fg-subtle pl-1 pointer-events-none" style={{ left: s * pxPerSec }}>{s}s</div>
              ))}
              <div className="absolute top-0 bottom-0 w-0.5 bg-brand pointer-events-none z-20" style={{ left: playhead * pxPerSec }} />
            </div>
            {layers.map((layer, li) => (
              <div key={layer.id}>
                {/* insertion strip above this layer */}
                <div className="flex h-2.5 items-center">
                  <div className="w-20 shrink-0" />
                  <div ref={(el) => { if (el) stripRefs.current.set(`strip-${li}`, el); else stripRefs.current.delete(`strip-${li}`); }}
                    onDragOver={(e) => { e.preventDefault(); setDropHint({ type: "strip", id: `strip-${li}` }); }}
                    onDragLeave={() => setDropHint((h) => (h?.type === "strip" && h.id === `strip-${li}` ? null : h))}
                    onDrop={(e) => onStripDrop(e, li)}
                    className={`flex-1 rounded transition-all ${dropHint?.type === "strip" && dropHint.id === `strip-${li}` ? "h-2.5 bg-brand/50 ring-1 ring-brand" : "h-0.5 bg-border/30"}`} />
                </div>
                <div className="flex items-stretch border-b border-border/40 min-h-[48px]">
                  <div className="w-20 shrink-0 flex items-center justify-between px-1.5 text-[9px] uppercase tracking-wider text-fg-subtle border-r border-border/40">
                    <span>{layer.name}</span>
                  </div>
                  <div ref={(el) => { if (el) laneRefs.current.set(layer.id, el); else laneRefs.current.delete(layer.id); }}
                    className={`relative flex-1 h-12 ${dropHint?.type === "lane" && dropHint.id === layer.id ? "bg-brand/10 ring-1 ring-inset ring-brand/50" : ""}`}
                    onDragOver={(e) => { e.preventDefault(); setDropHint({ type: "lane", id: layer.id }); }}
                    onDragLeave={() => setDropHint((h) => (h?.type === "lane" && h.id === layer.id ? null : h))}
                    onDrop={(e) => onLaneDrop(e, layer)}>
                    <div className="absolute top-0 bottom-0 w-0.5 bg-brand/60 pointer-events-none z-20" style={{ left: playhead * pxPerSec }} />
                    {onLayer(layer.id).map((c) => (
                      <div key={c.id} onPointerDown={(e) => onClipPointerDown(e, c, "move")} onClick={() => setSelected(c.id)} onContextMenu={(e) => onClipContext(e, c)}
                        style={{ left: c.start * pxPerSec, width: Math.max(24, c.duration * pxPerSec) }}
                        className={`absolute top-1.5 h-9 rounded px-2 text-[10px] leading-9 truncate cursor-grab active:cursor-grabbing border touch-none ${
                          selected === c.id ? "border-brand bg-brand/20 text-brand z-10"
                          : c.kind === "fx" ? "border-purple-500/50 bg-purple-500/15 text-purple-300"
                          : c.kind === "adjust" ? "border-cyan-500/50 bg-cyan-500/15 text-cyan-300"
                          : "border-border bg-bg-card text-fg-muted"}`}>
                        {c.kind === "fx" ? `FX: ${c.fx}` : c.kind === "adjust" ? `Adj: ${ADJUST.find((a) => a.v === c.fx)?.l ?? ""}` : c.kind === "text" ? (c.text || "Text") : c.label}
                        <span onPointerDown={(e) => onClipPointerDown(e, c, "trim")} className="absolute right-0 top-0 h-full w-2 cursor-ew-resize bg-brand/40 rounded-r" />
                      </div>
                    ))}
                    {/* transition "+" between adjacent clips (CapCut-style) */}
                    {(() => {
                      const lc = onLayer(layer.id).filter((c) => c.kind === "video" || c.kind === "image" || c.kind === "text");
                      return lc.map((b, idx) => {
                        if (idx === 0) return null;
                        const a = lc[idx - 1];
                        if (b.start > a.start + a.duration + 0.3) return null;
                        return (
                          <button key={`tr-${b.id}`}
                            onPointerDown={(e) => e.stopPropagation()}
                            onClick={(e) => { e.stopPropagation(); setTransMenu({ x: e.clientX, y: e.clientY, id: b.id }); }}
                            style={{ left: b.start * pxPerSec - 12 }} title="Transition"
                            className={`absolute top-1/2 -translate-y-1/2 z-40 grid place-items-center w-6 h-6 rounded-full text-[12px] leading-none border shadow ${b.transType ? "bg-amber-400 text-black border-amber-200" : "bg-bg-card text-fg-muted border-border hover:border-brand hover:text-brand hover:bg-bg-card"}`}>
                            {b.transType ? "◆" : "+"}
                          </button>
                        );
                      });
                    })()}
                  </div>
                </div>
                {/* bottom insertion strip after the last layer */}
                {li === layers.length - 1 && (
                  <div className="flex h-2.5 items-center">
                    <div className="w-20 shrink-0" />
                    <div ref={(el) => { if (el) stripRefs.current.set(`strip-${li + 1}`, el); else stripRefs.current.delete(`strip-${li + 1}`); }}
                      onDragOver={(e) => { e.preventDefault(); setDropHint({ type: "strip", id: `strip-${li + 1}` }); }}
                      onDragLeave={() => setDropHint((h) => (h?.type === "strip" && h.id === `strip-${li + 1}` ? null : h))}
                      onDrop={(e) => onStripDrop(e, li + 1)}
                      className={`flex-1 rounded transition-all ${dropHint?.type === "strip" && dropHint.id === `strip-${li + 1}` ? "h-2.5 bg-brand/50 ring-1 ring-brand" : "h-0.5 bg-border/30"}`} />
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Inspector */}
        {sel && (
          <div className="shrink-0 border-t border-border p-2 flex items-center gap-3 text-[11px] flex-wrap">
            <span className="text-fg-subtle uppercase tracking-wider">{sel.kind}</span>
            {sel.kind === "text" && (<input value={sel.text ?? ""} onChange={(e) => update(sel.id, { text: e.target.value })} className="bg-bg-card border border-border rounded px-2 py-1 text-fg w-40 outline-none focus:border-brand" placeholder="Caption" />)}
            {sel.kind === "fx" && (<select value={sel.fx} onChange={(e) => update(sel.id, { fx: e.target.value })} className="bg-bg-card border border-border rounded px-2 py-1 text-fg outline-none">{FX.map((f) => <option key={f.v} value={f.v}>{f.l}</option>)}</select>)}
            {sel.kind === "adjust" && (<select value={sel.fx} onChange={(e) => update(sel.id, { fx: e.target.value })} className="bg-bg-card border border-border rounded px-2 py-1 text-fg outline-none">{ADJUST.map((f) => <option key={f.v} value={f.v}>{f.l}</option>)}</select>)}
            <label className="flex items-center gap-1 text-fg-muted">start<input type="number" min={0} step={0.1} value={sel.start} onChange={(e) => update(sel.id, { start: Math.max(0, Number(e.target.value) || 0) })} className="bg-bg-card border border-border rounded px-1.5 py-1 w-14 text-fg outline-none focus:border-brand" />s</label>
            <label className="flex items-center gap-1 text-fg-muted">dur<input type="number" min={MIN_DUR} step={0.1} value={sel.duration} onChange={(e) => update(sel.id, { duration: Math.max(MIN_DUR, Number(e.target.value) || MIN_DUR) })} className="bg-bg-card border border-border rounded px-1.5 py-1 w-14 text-fg outline-none focus:border-brand" />s</label>
            {(sel.kind === "video" || sel.kind === "image" || sel.kind === "text") && (
              <>
                <label className="flex items-center gap-1 text-fg-muted">anim<select value={sel.anim ?? ""} onChange={(e) => update(sel.id, { anim: e.target.value })} className="bg-bg-card border border-border rounded px-1.5 py-1 text-fg outline-none">{ANIMS.map((a) => <option key={a.v} value={a.v}>{a.l}</option>)}</select></label>
                <label className="flex items-center gap-1 text-fg-muted">scale<input type="range" min={0.2} max={3} step={0.05} value={sel.scale} onChange={(e) => update(sel.id, { scale: Number(e.target.value) })} className="w-16" /></label>
              </>
            )}
            <label className="flex items-center gap-1 text-fg-muted">in<input type="number" min={0} step={0.1} value={sel.fadeIn} onChange={(e) => update(sel.id, { fadeIn: Math.max(0, Number(e.target.value) || 0) })} className="bg-bg-card border border-border rounded px-1.5 py-1 w-12 text-fg outline-none focus:border-brand" />s</label>
            <label className="flex items-center gap-1 text-fg-muted">out<input type="number" min={0} step={0.1} value={sel.fadeOut} onChange={(e) => update(sel.id, { fadeOut: Math.max(0, Number(e.target.value) || 0) })} className="bg-bg-card border border-border rounded px-1.5 py-1 w-12 text-fg outline-none focus:border-brand" />s</label>
            <button onClick={() => duplicate(sel.id)} className="text-fg-muted hover:text-fg inline-flex items-center gap-1"><Copy size={12} /> dup</button>
            <button onClick={() => remove(sel.id)} className="text-red-400 hover:text-red-300 inline-flex items-center gap-1 ml-auto"><Trash2 size={13} /> delete</button>
          </div>
        )}
      </div>

      {/* Context menu */}
      {menu && (() => {
        const c = clips.find((x) => x.id === menu.id);
        if (!c) return null;
        const apply = (patch: Partial<EditClip>) => { update(menu.id, patch); setMenu(null); };
        const isMedia = c.kind === "video" || c.kind === "image" || c.kind === "text";
        return (
          <div className="fixed z-50 w-52 bg-bg-card border border-border rounded-lg shadow-xl p-1.5 text-[11px]" style={{ left: Math.min(menu.x, window.innerWidth - 220), top: Math.min(menu.y, window.innerHeight - 360) }} onClick={(e) => e.stopPropagation()}>
            {isMedia && (
              <>
                <div className="px-1.5 py-1 text-fg-subtle uppercase tracking-wider text-[9px]">Animation</div>
                <div className="grid grid-cols-2 gap-1 px-1 pb-1.5">
                  {ANIMS.map((a) => (<button key={a.v} onClick={() => apply({ anim: a.v })} className={`px-1.5 py-1 rounded text-left ${(c.anim ?? "") === a.v ? "bg-brand/20 text-brand" : "hover:bg-white/5 text-fg-muted"}`}>{a.l}</button>))}
                </div>
              </>
            )}
            <div className="px-1.5 py-1 text-fg-subtle uppercase tracking-wider text-[9px]">Fade</div>
            <div className="grid grid-cols-2 gap-1 px-1 pb-1.5">
              <button onClick={() => apply({ fadeIn: 0.5 })} className="px-1.5 py-1 rounded hover:bg-white/5 text-fg-muted text-left">In 0.5s</button>
              <button onClick={() => apply({ fadeOut: 0.5 })} className="px-1.5 py-1 rounded hover:bg-white/5 text-fg-muted text-left">Out 0.5s</button>
              <button onClick={() => apply({ fadeIn: 0.5, fadeOut: 0.5 })} className="px-1.5 py-1 rounded hover:bg-white/5 text-fg-muted text-left">Both 0.5s</button>
              <button onClick={() => apply({ fadeIn: 0, fadeOut: 0 })} className="px-1.5 py-1 rounded hover:bg-white/5 text-fg-muted text-left">None</button>
            </div>
            <div className="border-t border-border my-1" />
            <button onClick={() => { duplicate(menu.id); setMenu(null); }} className="w-full px-1.5 py-1.5 rounded hover:bg-white/5 text-fg-muted text-left inline-flex items-center gap-2"><Copy size={12} /> Duplicate</button>
            <button onClick={() => { remove(menu.id); setMenu(null); }} className="w-full px-1.5 py-1.5 rounded hover:bg-red-500/10 text-red-400 text-left inline-flex items-center gap-2"><Trash2 size={12} /> Delete</button>
          </div>
        );
      })()}

      {/* Transition popover (from the "+" between clips) */}
      {transMenu && (() => {
        const b = clips.find((x) => x.id === transMenu.id);
        return (
          <div className="fixed z-50 w-44 bg-bg-card border border-border rounded-lg shadow-xl p-1.5 text-[11px]" style={{ left: Math.min(transMenu.x, window.innerWidth - 190), top: Math.min(transMenu.y, window.innerHeight - 240) }} onClick={(e) => e.stopPropagation()}>
            <div className="px-1.5 py-1 text-fg-subtle uppercase tracking-wider text-[9px]">Transition</div>
            <div className="grid grid-cols-2 gap-1 px-1 pb-1">
              {TRANSITIONS.map((a) => (
                <button key={a.v} onClick={() => applyTransition(transMenu.id, a.v)} className={`px-1.5 py-1 rounded text-left ${(b?.transType ?? "") === a.v ? "bg-amber-400/20 text-amber-300" : "hover:bg-white/5 text-fg-muted"}`}>{a.l}</button>
              ))}
            </div>
          </div>
        );
      })()}
    </div>
  );
}
