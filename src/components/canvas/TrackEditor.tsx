"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X, Loader2, Trash2, Plus, RotateCcw, Maximize2, Minimize2, Play, Pause, Copy, Clipboard, ZoomIn, ZoomOut } from "lucide-react";

// ─────────────────────────────────────────────────────────────────────────────
// TrackEditor — interactive, Mocha-style correction of the auto screen-track.
//   • Loads the per-frame auto-track (cached from the last run if available).
//   • Play or scrub the source video; the cyan quad shows where content lands.
//   • Drag a CORNER to corner-pin it, or the body/centre to move the whole quad;
//     a KEYFRAME is set automatically (per-corner offsets).
//   • Keyframes interpolate with a SMOOTH (time-aware Hermite) spline, identical
//     to the compositor, so the preview matches the render and there is no jerk
//     right after a key. Copy/paste keys, zoom the timeline for close keys.
//   • Emits keyframes as [{ t, c: [[dx,dy]×4] }].
// ─────────────────────────────────────────────────────────────────────────────

export type TrackKey = { t: number; c: number[][] }; // c = 4 corner offsets [[dx,dy]×4]
type Track = { fps: number; w: number; h: number; quads: number[][][] };
type Pt = [number, number];

const clamp01 = (n: unknown) => Math.max(0, Math.min(1, Number(n) || 0));
const ZERO = (): number[][] => [[0, 0], [0, 0], [0, 0], [0, 0]];

function normKeys(v: unknown): TrackKey[] {
  const arr = Array.isArray(v) ? v : [];
  return arr
    .map((k) => {
      const kk = k as { t?: unknown; c?: unknown; dx?: unknown; dy?: unknown };
      if (Array.isArray(kk?.c) && kk.c.length === 4) {
        return { t: clamp01(kk.t), c: (kk.c as unknown[]).map((p) => [Number((p as number[])?.[0]) || 0, Number((p as number[])?.[1]) || 0]) };
      }
      const u = [Number(kk?.dx) || 0, Number(kk?.dy) || 0];
      return { t: clamp01(kk?.t), c: [u, u, u, u] };
    })
    .sort((a, b) => a.t - b.t);
}

// Time-aware Hermite (Catmull-Rom) — C1-continuous in time. MUST match the
// compositor's interpCornerOffsets so the preview equals the render.
function interpCorners(keys: TrackKey[], t: number): number[][] {
  const n = keys.length;
  if (!n) return ZERO();
  if (n === 1 || t <= keys[0].t) return keys[0].c;
  if (t >= keys[n - 1].t) return keys[n - 1].c;
  let i = 0;
  for (let k = 0; k < n - 1; k++) { if (t >= keys[k].t && t <= keys[k + 1].t) { i = k; break; } }
  const ci = keys[i].c, cj = keys[i + 1].c, cm1 = i > 0 ? keys[i - 1].c : ci, cp2 = i + 2 < n ? keys[i + 2].c : cj;
  const ti = keys[i].t, tj = keys[i + 1].t, h = Math.max(tj - ti, 1e-6), s = (t - ti) / h;
  const tm1 = i > 0 ? keys[i - 1].t : ti, tp2 = i + 2 < n ? keys[i + 2].t : tj;
  const h00 = 2 * s * s * s - 3 * s * s + 1, h10 = s * s * s - 2 * s * s + s, h01 = -2 * s * s * s + 3 * s * s, h11 = s * s * s - s * s;
  const out: number[][] = [[0, 0], [0, 0], [0, 0], [0, 0]];
  for (let cc = 0; cc < 4; cc++) for (let d = 0; d < 2; d++) {
    const pI = ci[cc][d], pJ = cj[cc][d];
    const mI = i > 0 ? (pJ - cm1[cc][d]) / (tj - tm1) : (pJ - pI) / h;
    const mJ = i + 2 < n ? (cp2[cc][d] - pI) / (tp2 - ti) : (pJ - pI) / h;
    out[cc][d] = h00 * pI + h10 * h * mI + h01 * pJ + h11 * h * mJ;
  }
  return out;
}
function quadCenter(q: number[][]): Pt {
  return [(q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4, (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4];
}

export default function TrackEditor({
  source,
  value,
  cachedTrackUrl,
  onSave,
  onClose,
}: {
  source: string;
  value: TrackKey[];
  cachedTrackUrl?: string;
  onSave: (keys: TrackKey[]) => void;
  onClose: () => void;
}) {
  const [track, setTrack] = useState<Track | null>(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);
  const [fromCache, setFromCache] = useState(false);
  const [keys, setKeys] = useState<TrackKey[]>(normKeys(value));
  const [t, setT] = useState(0);
  const [dur, setDur] = useState(0);
  const [mounted, setMounted] = useState(false);
  const [big, setBig] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [clip, setClip] = useState<number[][] | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ mode: number | "move"; lastX: number; lastY: number } | null>(null);
  const raf = useRef<number | null>(null);

  useEffect(() => setMounted(true), []);
  useEffect(() => () => { if (raf.current) cancelAnimationFrame(raf.current); }, []);

  useEffect(() => {
    let off = false;
    setLoading(true); setErr("");
    (async () => {
      try {
        let j: Partial<Track> & { error?: string } = {};
        if (cachedTrackUrl) {
          try { const r = await fetch(cachedTrackUrl); if (r.ok) { j = await r.json(); if (j.quads) { if (!off) setFromCache(true); } } } catch { /* fall through */ }
        }
        if (!j.quads) {
          const r = await fetch("/api/screen-replace/track", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source }) });
          j = await r.json();
          if (!r.ok || !j.quads) { if (!off) { setErr(j.error || "Could not load track"); setLoading(false); } return; }
        }
        if (off) return;
        setTrack({ fps: j.fps || 30, w: j.w || 1920, h: j.h || 1080, quads: j.quads });
        setLoading(false);
      } catch (e) { if (!off) { setErr(e instanceof Error ? e.message : "error"); setLoading(false); } }
    })();
    return () => { off = true; };
  }, [source, cachedTrackUrl]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const nFrames = track ? track.quads.length : 0;
  const frame = nFrames ? Math.max(0, Math.min(nFrames - 1, Math.round(t * (nFrames - 1)))) : 0;
  const autoQuad = track ? track.quads[frame] : null;
  const offNow = interpCorners(keys, t);
  const correctedQuad = autoQuad ? autoQuad.map((p, i) => [p[0] + offNow[i][0], p[1] + offNow[i][1]]) : null;
  const keyHere = keys.find((k) => Math.abs(k.t - t) < 0.012);

  const stopPlay = useCallback(() => {
    if (raf.current) { cancelAnimationFrame(raf.current); raf.current = null; }
    if (videoRef.current) videoRef.current.pause();
    setPlaying(false);
  }, []);

  const togglePlay = () => {
    const v = videoRef.current; if (!v || !dur) return;
    if (playing) { stopPlay(); return; }
    if (t >= 0.999) { v.currentTime = 0; setT(0); }
    v.play().catch(() => {});
    setPlaying(true);
    const tick = () => {
      if (videoRef.current) setT(Math.min(1, (videoRef.current.currentTime || 0) / (dur || 1)));
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
  };

  const seek = (nt: number) => {
    stopPlay();
    const c = Math.max(0, Math.min(1, nt));
    setT(c);
    if (videoRef.current && dur) videoRef.current.currentTime = c * dur;
  };

  // Keep the playhead visible while playing on a zoomed timeline.
  useEffect(() => {
    if (!playing || zoom <= 1) return;
    const el = scrollRef.current; if (!el) return;
    const inner = el.scrollWidth;
    el.scrollLeft = Math.max(0, Math.min(inner - el.clientWidth, t * inner - el.clientWidth / 2));
  }, [t, zoom, playing]);

  const clientToSvg = (cx: number, cy: number): Pt | null => {
    const svg = svgRef.current; if (!svg) return null;
    const ctm = svg.getScreenCTM(); if (!ctm) return null;
    const p = svg.createSVGPoint(); p.x = cx; p.y = cy;
    const q = p.matrixTransform(ctm.inverse());
    return [q.x, q.y];
  };

  const baseC = useCallback((): number[][] => {
    const k = keys.find((kk) => Math.abs(kk.t - t) < 0.012);
    return (k ? k.c : interpCorners(keys, t)).map((o) => [o[0], o[1]]);
  }, [keys, t]);

  const upsertKeyC = useCallback((tt: number, c: number[][]) => {
    setKeys((prev) => {
      const idx = prev.findIndex((k) => Math.abs(k.t - tt) < 0.012);
      const nk: TrackKey = { t: Math.round(tt * 1000) / 1000, c: c.map((o) => [Math.round(o[0]), Math.round(o[1])]) };
      return (idx >= 0 ? prev.map((k, i) => (i === idx ? nk : k)) : [...prev, nk]).sort((a, b) => a.t - b.t);
    });
  }, []);

  const onPointerDown = (e: React.PointerEvent) => {
    if (!track || !autoQuad || !correctedQuad) return;
    stopPlay();
    const p = clientToSvg(e.clientX, e.clientY); if (!p) return;
    const hr = track.w / 28;
    let mode: number | "move" = "move";
    let best = hr;
    for (let i = 0; i < 4; i++) {
      const d = Math.hypot(correctedQuad[i][0] - p[0], correctedQuad[i][1] - p[1]);
      if (d < best) { best = d; mode = i; }
    }
    drag.current = { mode, lastX: p[0], lastY: p[1] };
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    e.preventDefault();
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current || !track || !autoQuad) return;
    const p = clientToSvg(e.clientX, e.clientY); if (!p) return;
    const d = drag.current;
    if (typeof d.mode === "number") {
      const c = baseC();
      c[d.mode] = [p[0] - autoQuad[d.mode][0], p[1] - autoQuad[d.mode][1]];
      upsertKeyC(t, c);
    } else {
      const dx = p[0] - d.lastX, dy = p[1] - d.lastY;
      upsertKeyC(t, baseC().map((o) => [o[0] + dx, o[1] + dy]));
      d.lastX = p[0]; d.lastY = p[1];
    }
  };
  const onPointerUp = (e: React.PointerEvent) => {
    drag.current = null;
    (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
  };

  const addZeroKey = () => upsertKeyC(t, ZERO());
  const deleteKeyHere = () => setKeys((prev) => prev.filter((k) => Math.abs(k.t - t) >= 0.012));
  const resetAll = () => setKeys([]);
  const copyKey = () => { if (keyHere) setClip(keyHere.c.map((o) => [o[0], o[1]])); };
  const pasteKey = () => { if (clip) upsertKeyC(t, clip); };

  const aspect = track ? `${track.w} / ${track.h}` : "9 / 16";
  const handleR = track ? track.w / 95 : 6;
  const strokeW = track ? Math.max(2, track.w / 520) : 2;
  const dashStroke = track ? Math.max(2.5, track.w / 380) : 3;

  if (!mounted) return null;
  return createPortal(
    <div className="fixed inset-0 z-[9999] bg-black/85 backdrop-blur-sm flex items-center justify-center p-3" onClick={onClose}>
      <div
        className={`bg-bg-card border border-border rounded-xl flex flex-col overflow-hidden shadow-panel ${big ? "w-[98vw] h-[97vh] max-w-none" : "w-full max-w-[880px] h-[90vh]"}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-border shrink-0 gap-2">
          <div className="text-[13px] font-medium text-fg truncate">Adjust track <span className="text-fg-subtle font-normal">— drag a corner to pin, or the body to move; keys are set as you go</span></div>
          <div className="flex items-center gap-1 shrink-0">
            <button type="button" onClick={() => setBig((b) => !b)} title={big ? "Shrink" : "Maximise"} className="w-7 h-7 rounded-md hover:bg-white/10 text-fg-muted flex items-center justify-center">{big ? <Minimize2 size={15} /> : <Maximize2 size={15} />}</button>
            <button type="button" onClick={onClose} className="w-7 h-7 rounded-md hover:bg-white/10 text-fg-muted flex items-center justify-center"><X size={16} /></button>
          </div>
        </div>

        {loading && (
          <div className="flex items-center gap-2 text-fg-muted text-[12px] py-20 justify-center"><Loader2 size={16} className="animate-spin" /> Analysing track… (faster after the first run)</div>
        )}
        {err && !loading && <div className="text-[12px] text-red-400 py-20 text-center px-6">{err}</div>}

        {track && !loading && (
          <div className="flex-1 min-h-0 flex flex-col md:flex-row">
            {/* video + transport + timeline */}
            <div className="flex-1 min-h-0 flex flex-col p-3 gap-2 bg-black/30">
              <div className="flex-1 min-h-0 flex items-center justify-center">
                <div className="relative h-full max-h-full max-w-full bg-black rounded-lg overflow-hidden" style={{ aspectRatio: aspect }}>
                  <video ref={videoRef} src={source} className="absolute inset-0 w-full h-full object-contain" onLoadedMetadata={(e) => setDur(e.currentTarget.duration || 0)} onEnded={stopPlay} playsInline muted />
                  <svg
                    ref={svgRef}
                    viewBox={`0 0 ${track.w} ${track.h}`}
                    className="absolute inset-0 w-full h-full touch-none cursor-move"
                    preserveAspectRatio="xMidYMid meet"
                    onPointerDown={onPointerDown}
                    onPointerMove={onPointerMove}
                    onPointerUp={onPointerUp}
                    onPointerCancel={onPointerUp}
                  >
                    {autoQuad && (
                      <>
                        {/* dark backing makes the dashed auto-track readable on any frame */}
                        <polygon points={autoQuad.map((p) => p.join(",")).join(" ")} fill="none" stroke="#000000" strokeWidth={dashStroke * 1.9} strokeDasharray={`${track.w / 70} ${track.w / 90}`} opacity={0.55} />
                        <polygon points={autoQuad.map((p) => p.join(",")).join(" ")} fill="none" stroke="#fbbf24" strokeWidth={dashStroke} strokeDasharray={`${track.w / 70} ${track.w / 90}`} />
                      </>
                    )}
                    {correctedQuad && (
                      <>
                        <polygon points={correctedQuad.map((p) => p.join(",")).join(" ")} fill="#22d3ee22" stroke="#22d3ee" strokeWidth={strokeW} />
                        {(() => { const c = quadCenter(correctedQuad); return <circle cx={c[0]} cy={c[1]} r={handleR * 0.8} fill="#22d3ee" opacity={0.5} />; })()}
                        {correctedQuad.map((p, i) => (
                          <g key={i}>
                            <circle cx={p[0]} cy={p[1]} r={handleR} fill="#0e7490" stroke="#22d3ee" strokeWidth={strokeW} />
                            <circle cx={p[0]} cy={p[1]} r={handleR * 2.4} fill="transparent" />
                          </g>
                        ))}
                      </>
                    )}
                  </svg>
                </div>
              </div>

              {/* transport + zoomable timeline */}
              <div className="shrink-0">
                <div className="flex items-center gap-2 mb-1">
                  <button type="button" onClick={togglePlay} className="w-8 h-8 rounded-md bg-white/10 hover:bg-white/20 text-fg flex items-center justify-center shrink-0">{playing ? <Pause size={15} /> : <Play size={15} />}</button>
                  <span className="text-[10px] text-fg-subtle tabular-nums shrink-0">frame {frame}/{nFrames - 1}{fromCache ? " · cached" : ""}</span>
                  <div className="ml-auto flex items-center gap-1 shrink-0">
                    <button type="button" onClick={() => setZoom((z) => Math.max(1, z - 1))} disabled={zoom <= 1} className="w-6 h-6 rounded border border-border text-fg-muted hover:text-fg disabled:opacity-40 flex items-center justify-center"><ZoomOut size={12} /></button>
                    <span className="text-[10px] text-fg-subtle tabular-nums w-7 text-center">{zoom}×</span>
                    <button type="button" onClick={() => setZoom((z) => Math.min(16, z + 1))} disabled={zoom >= 16} className="w-6 h-6 rounded border border-border text-fg-muted hover:text-fg disabled:opacity-40 flex items-center justify-center"><ZoomIn size={12} /></button>
                  </div>
                </div>
                <div ref={scrollRef} className="overflow-x-auto overflow-y-hidden">
                  <div className="relative" style={{ width: `${zoom * 100}%` }}>
                    <input type="range" min={0} max={1000} value={Math.round(t * 1000)} onChange={(e) => seek(Number(e.target.value) / 1000)} className="w-full accent-brand cursor-pointer" />
                    <div className="relative h-3">
                      {keys.map((k, i) => (
                        <button key={i} type="button" title={`keyframe @ ${(k.t * 100).toFixed(1)}%`} onClick={() => seek(k.t)}
                          className={`absolute -translate-x-1/2 w-2.5 h-2.5 rounded-sm border hover:scale-125 transition ${keyHere && Math.abs(keyHere.t - k.t) < 0.012 ? "bg-cyan-300 border-cyan-500" : "bg-amber-400 border-amber-600"}`} style={{ left: `${k.t * 100}%`, top: 0 }} />
                      ))}
                    </div>
                  </div>
                </div>
                <div className="flex items-center justify-end text-[10px] text-fg-subtle tabular-nums pt-0.5">
                  <span>{track.fps} fps · {(t * 100).toFixed(1)}%</span>
                </div>
              </div>
            </div>

            {/* controls */}
            <div className="w-full md:w-64 border-t md:border-t-0 md:border-l border-border p-3 overflow-y-auto shrink-0 space-y-2.5">
              <div className="grid grid-cols-2 gap-1.5">
                <button type="button" onClick={addZeroKey} className="inline-flex items-center justify-center gap-1 px-2 py-1.5 rounded text-[11px] border border-border text-fg-muted hover:text-fg hover:border-brand"><Plus size={12} /> Key (0)</button>
                <button type="button" onClick={deleteKeyHere} disabled={!keyHere} className="inline-flex items-center justify-center gap-1 px-2 py-1.5 rounded text-[11px] border border-border text-fg-muted hover:text-fg hover:border-red-500 disabled:opacity-40"><Trash2 size={12} /> Delete</button>
                <button type="button" onClick={copyKey} disabled={!keyHere} className="inline-flex items-center justify-center gap-1 px-2 py-1.5 rounded text-[11px] border border-border text-fg-muted hover:text-fg hover:border-brand disabled:opacity-40"><Copy size={12} /> Copy</button>
                <button type="button" onClick={pasteKey} disabled={!clip} className="inline-flex items-center justify-center gap-1 px-2 py-1.5 rounded text-[11px] border border-border text-fg-muted hover:text-fg hover:border-brand disabled:opacity-40"><Clipboard size={12} /> Paste</button>
              </div>
              <button type="button" onClick={resetAll} disabled={!keys.length} className="w-full inline-flex items-center justify-center gap-1 px-2 py-1.5 rounded text-[11px] border border-border text-fg-muted hover:text-fg disabled:opacity-40"><RotateCcw size={12} /> Reset all</button>
              <div className="text-[11px] text-fg-subtle">{keys.length} keyframe{keys.length === 1 ? "" : "s"}{keyHere ? " · keyed here" : ""}{clip ? " · 1 copied" : ""}</div>
              <p className="text-[10px] text-fg-subtle leading-snug border-t border-border pt-2">
                <span className="inline-block w-2 h-2 align-middle rounded-sm bg-cyan-400 mr-1" /> cyan = content lands here · <span className="inline-block w-3 h-0 align-middle border-t-2 border-dashed border-amber-400 mr-1" /> = auto-track.
                <br /><br />
                Keys interpolate on a <b>smooth</b> curve (no jerk after a key). Fix one moment by dragging a corner/the body; drop neutral <b>Key (0)</b>s on the good frames either side so the fix eases in and out. <b>Copy/Paste</b> reuses a key; <b>zoom</b> (top-right) spreads close keys. Then <b>Save</b> and re-run the node.
              </p>
            </div>
          </div>
        )}

        <div className="flex items-center justify-end gap-2 px-4 py-2.5 border-t border-border shrink-0">
          <button type="button" onClick={onClose} className="px-3 py-1.5 rounded text-[12px] text-fg-muted hover:text-fg">Cancel</button>
          <button type="button" onClick={() => { onSave(keys); onClose(); }} className="px-4 py-1.5 rounded text-[12px] bg-brand text-white hover:bg-brand/90 font-medium">Save keyframes</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
