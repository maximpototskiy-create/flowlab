"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { X, Loader2, Trash2, Plus, RotateCcw, Maximize2 } from "lucide-react";

// ─────────────────────────────────────────────────────────────────────────────
// TrackEditor — interactive, Mocha-style correction of the auto screen-track.
//   • Loads the per-frame auto-track (cached from the last run if available, else
//     computed via /api/screen-replace/track).
//   • Scrub the source video; the cyan quad shows where the content will land.
//   • Drag a CORNER handle → corner-pin that corner; drag the body/centre → move
//     the whole quad. Either way a KEYFRAME is set at that moment (per-corner
//     offsets). Frames away from a key stay as the auto-track.
//   • Emits keyframes as [{ t, c: [[dx,dy]×4] }] consumed by the compositor.
// ─────────────────────────────────────────────────────────────────────────────

export type TrackKey = { t: number; c: number[][] }; // c = 4 corner offsets [[dx,dy]×4]
type Track = { fps: number; w: number; h: number; quads: number[][][] };
type Pt = [number, number];

const clamp01 = (n: unknown) => Math.max(0, Math.min(1, Number(n) || 0));
const ZERO = (): number[][] => [[0, 0], [0, 0], [0, 0], [0, 0]];

// Normalize incoming keys: per-corner `c`, or legacy uniform dx/dy → 4 equal corners.
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

function interpCorners(keys: TrackKey[], t: number): number[][] {
  if (!keys.length) return ZERO();
  if (t <= keys[0].t) return keys[0].c;
  const last = keys[keys.length - 1];
  if (t >= last.t) return last.c;
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i], b = keys[i + 1];
    if (t >= a.t && t <= b.t) {
      const f = (t - a.t) / ((b.t - a.t) || 1e-6);
      return [0, 1, 2, 3].map((j) => [a.c[j][0] + (b.c[j][0] - a.c[j][0]) * f, a.c[j][1] + (b.c[j][1] - a.c[j][1]) * f]);
    }
  }
  return ZERO();
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
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const drag = useRef<{ mode: number | "move"; lastX: number; lastY: number } | null>(null);

  useEffect(() => {
    let off = false;
    setLoading(true); setErr("");
    (async () => {
      try {
        let j: Partial<Track> & { error?: string } = {};
        if (cachedTrackUrl) {
          try { const r = await fetch(cachedTrackUrl); if (r.ok) { j = await r.json(); if (j.quads) { if (!off) setFromCache(true); } } } catch { /* fall through to compute */ }
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

  const seek = (nt: number) => {
    const c = Math.max(0, Math.min(1, nt));
    setT(c);
    if (videoRef.current && dur) videoRef.current.currentTime = c * dur;
  };

  const clientToSvg = (cx: number, cy: number): Pt | null => {
    const svg = svgRef.current; if (!svg) return null;
    const ctm = svg.getScreenCTM(); if (!ctm) return null;
    const p = svg.createSVGPoint(); p.x = cx; p.y = cy;
    const q = p.matrixTransform(ctm.inverse());
    return [q.x, q.y];
  };

  // Start a new/updated key at t from the current state (existing key or interpolated).
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
    const p = clientToSvg(e.clientX, e.clientY); if (!p) return;
    const hr = track.w / 28; // generous grab radius (working-res px)
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

  const aspect = track ? `${track.w} / ${track.h}` : "9 / 16";
  const handleR = track ? track.w / 95 : 6;
  const strokeW = track ? Math.max(2, track.w / 520) : 2;

  return (
    <div className="fixed inset-0 z-[9999] bg-black/85 backdrop-blur-sm flex items-center justify-center p-3" onClick={onClose}>
      <div className="bg-bg-card border border-border rounded-xl w-full max-w-[1040px] max-h-[96vh] flex flex-col overflow-hidden shadow-panel" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-border shrink-0">
          <div className="text-[13px] font-medium text-fg">Adjust track <span className="text-fg-subtle font-normal">— drag the corners to pin the screen, or the body to move it; keyframes are set as you go</span></div>
          <button type="button" onClick={onClose} className="w-7 h-7 rounded-md hover:bg-white/10 text-fg-muted flex items-center justify-center"><X size={16} /></button>
        </div>

        {loading && (
          <div className="flex items-center gap-2 text-fg-muted text-[12px] py-20 justify-center"><Loader2 size={16} className="animate-spin" /> Analysing track… (faster after the first run)</div>
        )}
        {err && !loading && <div className="text-[12px] text-red-400 py-20 text-center px-6">{err}</div>}

        {track && !loading && (
          <div className="flex-1 min-h-0 flex flex-col md:flex-row">
            {/* video + scrub */}
            <div className="flex-1 min-h-0 flex flex-col p-3 gap-2 bg-black/30">
              <div className="flex-1 min-h-0 flex items-center justify-center">
                <div className="relative max-h-full max-w-full bg-black rounded-lg overflow-hidden" style={{ aspectRatio: aspect, height: "min(82vh, 100%)" }}>
                  <video ref={videoRef} src={source} className="absolute inset-0 w-full h-full object-contain" onLoadedMetadata={(e) => setDur(e.currentTarget.duration || 0)} playsInline muted />
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
                      <polygon points={autoQuad.map((p) => p.join(",")).join(" ")} fill="none" stroke="#94a3b8" strokeWidth={Math.max(1.5, track.w / 760)} strokeDasharray={`${track.w / 110} ${track.w / 160}`} opacity={0.6} />
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
              {/* scrub */}
              <div className="shrink-0">
                <input type="range" min={0} max={1000} value={Math.round(t * 1000)} onChange={(e) => seek(Number(e.target.value) / 1000)} className="w-full accent-brand cursor-pointer" />
                <div className="relative h-3">
                  {keys.map((k, i) => (
                    <button key={i} type="button" title={`keyframe @ ${(k.t * 100).toFixed(0)}%`} onClick={() => seek(k.t)}
                      className="absolute -translate-x-1/2 w-2.5 h-2.5 rounded-sm bg-amber-400 border border-amber-600 hover:scale-125 transition" style={{ left: `${k.t * 100}%`, top: 0 }} />
                  ))}
                </div>
                <div className="flex items-center justify-between text-[10px] text-fg-subtle tabular-nums">
                  <span>frame {frame} / {nFrames - 1}{fromCache ? " · cached" : ""}</span>
                  <span>{track.fps} fps · {(t * 100).toFixed(0)}%</span>
                </div>
              </div>
            </div>

            {/* controls */}
            <div className="w-full md:w-64 border-t md:border-t-0 md:border-l border-border p-3 overflow-y-auto shrink-0 space-y-3">
              <div className="grid grid-cols-2 gap-1.5">
                <button type="button" onClick={addZeroKey} className="inline-flex items-center justify-center gap-1 px-2 py-1.5 rounded text-[11px] border border-border text-fg-muted hover:text-fg hover:border-brand"><Plus size={12} /> Key (0)</button>
                <button type="button" onClick={deleteKeyHere} disabled={!keyHere} className="inline-flex items-center justify-center gap-1 px-2 py-1.5 rounded text-[11px] border border-border text-fg-muted hover:text-fg hover:border-red-500 disabled:opacity-40"><Trash2 size={12} /> Delete</button>
              </div>
              <button type="button" onClick={resetAll} disabled={!keys.length} className="w-full inline-flex items-center justify-center gap-1 px-2 py-1.5 rounded text-[11px] border border-border text-fg-muted hover:text-fg disabled:opacity-40"><RotateCcw size={12} /> Reset all</button>
              <div className="text-[11px] text-fg-subtle">{keys.length} keyframe{keys.length === 1 ? "" : "s"}{keyHere ? " · keyed here" : ""}</div>
              <p className="text-[10px] text-fg-subtle leading-snug border-t border-border pt-2">
                <span className="inline-block w-2 h-2 align-middle rounded-sm bg-cyan-400 mr-1" /> cyan = where the content lands · dashed = auto-track.
                <br /><br />
                Scrub to a frame where it&apos;s off. Drag a <b>corner</b> to pin it, or the <b>middle</b> to slide the whole screen — a keyframe is set automatically. Drop a <b>Key (0)</b> just before/after to keep the fix local. Then <b>Save</b> and re-run the node.
                <br /><br />
                <Maximize2 size={10} className="inline align-middle mr-1" /> Window scales with the modal — corners are easier to grab on a big screen.
              </p>
            </div>
          </div>
        )}

        <div className="flex items-center justify-end gap-2 px-4 py-2.5 border-t border-border shrink-0">
          <button type="button" onClick={onClose} className="px-3 py-1.5 rounded text-[12px] text-fg-muted hover:text-fg">Cancel</button>
          <button type="button" onClick={() => { onSave(keys); onClose(); }} className="px-4 py-1.5 rounded text-[12px] bg-brand text-white hover:bg-brand/90 font-medium">Save keyframes</button>
        </div>
      </div>
    </div>
  );
}
