"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { X, Loader2, Trash2, Plus, RotateCcw } from "lucide-react";

// ─────────────────────────────────────────────────────────────────────────────
// TrackEditor — interactive, Mocha-style correction of the auto screen-track.
//
//   • Loads the per-frame auto-track from /api/screen-replace/track.
//   • Plays/scrubs the source video; overlays the tracked screen quad.
//   • Drag the overlay at a frame → sets/updates a KEYFRAME (offset delta from the
//     auto-track at that moment). Frames away from a key stay as the auto-track,
//     so fixing one jerk doesn't move the rest. Linear interpolation between keys.
//   • Emits keyframes as [{ t, dx, dy, rot }] (t in 0..1) via onSave — exactly the
//     `track_keys` shape consumed by the Screen Replace compositor.
//
// Reused by BOTH the canvas node modal and (later) the timeline editor.
// ─────────────────────────────────────────────────────────────────────────────

export type TrackKey = { t: number; dx: number; dy: number; rot?: number };
type Track = { fps: number; w: number; h: number; quads: number[][][] };
type Pt = [number, number];

function quadCenter(q: number[][]): Pt {
  return [(q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4, (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4];
}
function transformQuad(q: number[][], dx: number, dy: number, rotDeg: number): number[][] {
  const [cx, cy] = quadCenter(q);
  const ca = Math.cos((rotDeg * Math.PI) / 180), sa = Math.sin((rotDeg * Math.PI) / 180);
  return q.map(([px, py]) => {
    const rx = px - cx, ry = py - cy;
    return [cx + rx * ca - ry * sa + dx, cy + rx * sa + ry * ca + dy];
  });
}
function interpCorr(keys: TrackKey[], t: number): { dx: number; dy: number; rot: number } {
  if (!keys.length) return { dx: 0, dy: 0, rot: 0 };
  if (t <= keys[0].t) return { dx: keys[0].dx, dy: keys[0].dy, rot: keys[0].rot ?? 0 };
  const last = keys[keys.length - 1];
  if (t >= last.t) return { dx: last.dx, dy: last.dy, rot: last.rot ?? 0 };
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i], b = keys[i + 1];
    if (t >= a.t && t <= b.t) {
      const f = (t - a.t) / ((b.t - a.t) || 1e-6);
      return {
        dx: a.dx + (b.dx - a.dx) * f,
        dy: a.dy + (b.dy - a.dy) * f,
        rot: (a.rot ?? 0) + ((b.rot ?? 0) - (a.rot ?? 0)) * f,
      };
    }
  }
  return { dx: 0, dy: 0, rot: 0 };
}

export default function TrackEditor({
  source,
  value,
  onSave,
  onClose,
}: {
  source: string;
  value: TrackKey[];
  onSave: (keys: TrackKey[]) => void;
  onClose: () => void;
}) {
  const [track, setTrack] = useState<Track | null>(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);
  const [keys, setKeys] = useState<TrackKey[]>(
    [...(value || [])].map((k) => ({ t: k.t, dx: k.dx || 0, dy: k.dy || 0, rot: k.rot || 0 })).sort((a, b) => a.t - b.t),
  );
  const [t, setT] = useState(0); // normalized 0..1
  const [dur, setDur] = useState(0);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragging = useRef(false);

  useEffect(() => {
    let off = false;
    setLoading(true); setErr("");
    (async () => {
      try {
        const r = await fetch("/api/screen-replace/track", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source }),
        });
        const j = (await r.json()) as Partial<Track> & { error?: string };
        if (off) return;
        if (!r.ok || !j.quads || !j.quads.length) { setErr(j.error || "Could not load track"); setLoading(false); return; }
        setTrack({ fps: j.fps || 30, w: j.w || 1920, h: j.h || 1080, quads: j.quads });
        setLoading(false);
      } catch (e) { if (!off) { setErr(e instanceof Error ? e.message : "error"); setLoading(false); } }
    })();
    return () => { off = true; };
  }, [source]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const nFrames = track ? track.quads.length : 0;
  const frame = nFrames ? Math.max(0, Math.min(nFrames - 1, Math.round(t * (nFrames - 1)))) : 0;
  const autoQuad = track ? track.quads[frame] : null;
  const corr = interpCorr(keys, t);
  const correctedQuad = autoQuad ? transformQuad(autoQuad, corr.dx, corr.dy, corr.rot) : null;

  const seek = (nt: number) => {
    const c = Math.max(0, Math.min(1, nt));
    setT(c);
    if (videoRef.current && dur) videoRef.current.currentTime = c * dur;
  };

  const clientToSvg = (clientX: number, clientY: number): Pt | null => {
    const svg = svgRef.current;
    if (!svg) return null;
    const ctm = svg.getScreenCTM();
    if (!ctm) return null;
    const p = svg.createSVGPoint(); p.x = clientX; p.y = clientY;
    const q = p.matrixTransform(ctm.inverse());
    return [q.x, q.y];
  };

  const upsertKey = useCallback((tt: number, dx: number, dy: number) => {
    setKeys((prev) => {
      const idx = prev.findIndex((k) => Math.abs(k.t - tt) < 0.012);
      const nk: TrackKey = { t: Math.round(tt * 1000) / 1000, dx: Math.round(dx), dy: Math.round(dy), rot: idx >= 0 ? prev[idx].rot || 0 : 0 };
      const next = idx >= 0 ? prev.map((k, i) => (i === idx ? nk : k)) : [...prev, nk];
      return next.sort((a, b) => a.t - b.t);
    });
  }, []);

  const onPointerDown = (e: React.PointerEvent) => {
    if (!track || !autoQuad) return;
    dragging.current = true;
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    e.preventDefault();
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging.current || !track || !autoQuad) return;
    const p = clientToSvg(e.clientX, e.clientY);
    if (!p) return;
    const ac = quadCenter(autoQuad);
    upsertKey(t, p[0] - ac[0], p[1] - ac[1]);
  };
  const onPointerUp = (e: React.PointerEvent) => {
    dragging.current = false;
    (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
  };

  const addZeroKey = () => upsertKey(t, 0, 0);
  const deleteKeyHere = () => setKeys((prev) => prev.filter((k) => Math.abs(k.t - t) >= 0.012));
  const resetAll = () => setKeys([]);
  const nudgeRot = (d: number) => {
    setKeys((prev) => {
      const idx = prev.findIndex((k) => Math.abs(k.t - t) < 0.012);
      if (idx >= 0) return prev.map((k, i) => (i === idx ? { ...k, rot: Math.round(((k.rot || 0) + d) * 10) / 10 } : k));
      return [...prev, { t: Math.round(t * 1000) / 1000, dx: Math.round(corr.dx), dy: Math.round(corr.dy), rot: d }].sort((a, b) => a.t - b.t);
    });
  };

  const aspect = track ? `${track.w} / ${track.h}` : "16 / 9";
  const keyHere = keys.find((k) => Math.abs(k.t - t) < 0.012);

  return (
    <div className="fixed inset-0 z-[9999] bg-black/85 backdrop-blur-sm flex items-center justify-center p-3" onClick={onClose}>
      <div className="bg-bg-card border border-border rounded-xl w-full max-w-3xl max-h-[94vh] flex flex-col overflow-hidden shadow-panel" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-border">
          <div className="text-[13px] font-medium text-fg">Adjust track <span className="text-fg-subtle font-normal">— drag the overlay to fix the screen, set keyframes</span></div>
          <button type="button" onClick={onClose} className="w-7 h-7 rounded-md hover:bg-white/10 text-fg-muted flex items-center justify-center"><X size={16} /></button>
        </div>

        <div className="flex-1 overflow-auto p-3 space-y-3">
          {loading && (
            <div className="flex items-center gap-2 text-fg-muted text-[12px] py-10 justify-center"><Loader2 size={16} className="animate-spin" /> Analysing track… (this can take a bit on long clips)</div>
          )}
          {err && !loading && (
            <div className="text-[12px] text-red-400 py-10 text-center">{err}</div>
          )}
          {track && !loading && (
            <>
              <div className="relative mx-auto bg-black rounded-lg overflow-hidden" style={{ aspectRatio: aspect, maxHeight: "60vh" }}>
                <video
                  ref={videoRef}
                  src={source}
                  className="absolute inset-0 w-full h-full object-contain"
                  onLoadedMetadata={(e) => setDur(e.currentTarget.duration || 0)}
                  playsInline
                  muted
                />
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
                    <polygon points={autoQuad.map((p) => p.join(",")).join(" ")} fill="none" stroke="#94a3b8" strokeWidth={Math.max(1.5, track.w / 640)} strokeDasharray={`${track.w / 110} ${track.w / 160}`} opacity={0.7} />
                  )}
                  {correctedQuad && (
                    <>
                      <polygon points={correctedQuad.map((p) => p.join(",")).join(" ")} fill="#22d3ee22" stroke="#22d3ee" strokeWidth={Math.max(2, track.w / 520)} />
                      {correctedQuad.map((p, i) => (
                        <circle key={i} cx={p[0]} cy={p[1]} r={track.w / 150} fill="#22d3ee" />
                      ))}
                      {(() => { const c = quadCenter(correctedQuad); return <circle cx={c[0]} cy={c[1]} r={track.w / 110} fill="#22d3ee" stroke="#0e7490" strokeWidth={track.w / 600} />; })()}
                    </>
                  )}
                </svg>
              </div>

              {/* scrub bar + keyframe markers */}
              <div className="relative pt-1">
                <input type="range" min={0} max={1000} value={Math.round(t * 1000)} onChange={(e) => seek(Number(e.target.value) / 1000)} className="w-full accent-brand cursor-pointer" />
                <div className="relative h-3">
                  {keys.map((k, i) => (
                    <button key={i} type="button" title={`keyframe @ ${(k.t * 100).toFixed(0)}%  dx${k.dx} dy${k.dy}${k.rot ? ` rot${k.rot}` : ""}`} onClick={() => seek(k.t)}
                      className="absolute -translate-x-1/2 w-2.5 h-2.5 rounded-sm bg-amber-400 border border-amber-600 hover:scale-125 transition" style={{ left: `${k.t * 100}%`, top: 0 }} />
                  ))}
                </div>
                <div className="flex items-center justify-between text-[10px] text-fg-subtle tabular-nums">
                  <span>frame {frame} / {nFrames - 1}</span>
                  <span>{track.fps} fps · {(t * 100).toFixed(0)}%</span>
                </div>
              </div>

              {/* controls */}
              <div className="flex flex-wrap items-center gap-1.5">
                <button type="button" onClick={addZeroKey} className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] border border-border text-fg-muted hover:text-fg hover:border-brand"><Plus size={12} /> Key here (0)</button>
                <button type="button" onClick={deleteKeyHere} disabled={!keyHere} className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] border border-border text-fg-muted hover:text-fg hover:border-red-500 disabled:opacity-40"><Trash2 size={12} /> Delete key</button>
                <span className="text-[11px] text-fg-subtle px-1">rot</span>
                <button type="button" onClick={() => nudgeRot(-0.5)} className="px-2 py-1 rounded text-[11px] border border-border text-fg-muted hover:text-fg">−</button>
                <button type="button" onClick={() => nudgeRot(0.5)} className="px-2 py-1 rounded text-[11px] border border-border text-fg-muted hover:text-fg">+</button>
                <button type="button" onClick={resetAll} disabled={!keys.length} className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] border border-border text-fg-muted hover:text-fg disabled:opacity-40"><RotateCcw size={12} /> Reset</button>
                <span className="ml-auto text-[11px] text-fg-subtle">{keys.length} keyframe{keys.length === 1 ? "" : "s"}{keyHere ? ` · here: dx${keyHere.dx} dy${keyHere.dy}${keyHere.rot ? ` rot${keyHere.rot}` : ""}` : ""}</span>
              </div>

              <p className="text-[10px] text-fg-subtle leading-snug">
                Dashed grey = auto-track · cyan = where the content will land. Scrub to a frame where it&apos;s off, drag the cyan overlay onto the screen → a keyframe is set. Add zero-keys just before/after to keep the fix local. Save, then re-run the node.
              </p>
            </>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-4 py-2.5 border-t border-border">
          <button type="button" onClick={onClose} className="px-3 py-1.5 rounded text-[12px] text-fg-muted hover:text-fg">Cancel</button>
          <button type="button" onClick={() => { onSave(keys); onClose(); }} className="px-3 py-1.5 rounded text-[12px] bg-brand text-white hover:bg-brand/90">Save keyframes</button>
        </div>
      </div>
    </div>
  );
}
