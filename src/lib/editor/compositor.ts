// src/lib/editor/compositor.ts
// Shared visual math for preview AND export so they always match.
// Computes per-clip opacity, scale, offset (as a fraction of the frame),
// and an optional left-to-right reveal (for wipe), combining:
//   - fade in/out
//   - animation presets (Ken Burns, zoom, slide, pulse, shake)
//   - TRANSITIONS between two overlapping clips on the same track
//
// Transition model (CapCut-like, acts on BOTH clips):
//   Overlap clip B onto the tail of clip A (same track) and give B a
//   `transType`. During the overlap region the transition blends A (outgoing)
//   and B (incoming). The overlap region IS the transition — clearly bounded.

export type CompClip = {
  id: string;
  layer: string;
  kind: "video" | "image" | "audio" | "text" | "fx" | "adjust";
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

export const TRANSITIONS: { v: string; l: string }[] = [
  { v: "", l: "None" },
  { v: "crossfade", l: "Crossfade" },
  { v: "dipBlack", l: "Dip to black" },
  { v: "slideL", l: "Slide ←" },
  { v: "slideR", l: "Slide →" },
  { v: "slideUp", l: "Slide ↑" },
  { v: "zoom", l: "Zoom" },
  { v: "wipe", l: "Wipe" },
];

export function alphaAt(c: { start: number; duration: number; fadeIn: number; fadeOut: number }, tt: number): number {
  if (tt < c.start || tt >= c.start + c.duration) return 0;
  const into = tt - c.start, toEnd = c.start + c.duration - tt;
  let a = 1;
  if (c.fadeIn > 0) a = Math.min(a, into / c.fadeIn);
  if (c.fadeOut > 0) a = Math.min(a, toEnd / c.fadeOut);
  return Math.max(0, Math.min(1, a));
}
const easeOut = (x: number) => 1 - (1 - x) * (1 - x);

export function computeAnim(c: { start: number; duration: number; anim?: string }, tt: number): { s: number; fx: number; fy: number } {
  const dur = Math.max(0.001, c.duration);
  const p = Math.min(1, Math.max(0, (tt - c.start) / dur));
  let s = 1, fx = 0, fy = 0;
  switch (c.anim) {
    case "kenBurns": s = 1 + 0.12 * p; fx = -0.04 * p; fy = -0.02 * p; break;
    case "zoomIn": s = 1 + 0.25 * p; break;
    case "zoomOut": s = 1.25 - 0.25 * p; break;
    case "slideL": fx = -(1 - easeOut(Math.min(1, p / 0.25))); break;
    case "slideR": fx = (1 - easeOut(Math.min(1, p / 0.25))); break;
    case "pulse": s = 1 + 0.05 * Math.sin(p * Math.PI * 6); break;
    case "shake": fx = 0.012 * Math.sin(tt * 40); fy = 0.012 * Math.cos(tt * 37); break;
  }
  return { s, fx, fy };
}

const end = (c: CompClip) => c.start + c.duration;
const isVisualKind = (k: CompClip["kind"]) => k === "video" || k === "image" || k === "text";
// previous visual clip on the same layer that overlaps c's start
function prevOverlap(c: CompClip, all: CompClip[]): CompClip | null {
  let best: CompClip | null = null;
  for (const a of all) {
    if (a === c || a.layer !== c.layer || !isVisualKind(a.kind)) continue;
    if (a.start < c.start && end(a) > c.start) { if (!best || a.start > best.start) best = a; }
  }
  return best;
}
// next clip (with a transition) that overlaps c's tail
function nextTransOverlap(c: CompClip, all: CompClip[]): CompClip | null {
  let best: CompClip | null = null;
  for (const b of all) {
    if (b === c || b.layer !== c.layer || !b.transType || !isVisualKind(b.kind)) continue;
    if (b.start > c.start && b.start < end(c)) { if (!best || b.start < best.start) best = b; }
  }
  return best;
}

export type Visual = { opacity: number; scaleMul: number; offX: number; offY: number; reveal: number | null };

// Full visual state of a clip at time tt (fade × transition, anim folded into offsets/scale).
export function clipVisual(c: CompClip, tt: number, all: CompClip[]): Visual {
  const anim = computeAnim(c, tt);
  let opacity = alphaAt(c, tt);
  let scaleMul = anim.s;
  let offX = anim.fx, offY = anim.fy;
  let reveal: number | null = null;

  // incoming (c is B): transition over the previous overlapping clip
  if (c.transType) {
    const a = prevOverlap(c, all);
    if (a) {
      const ovEnd = Math.min(end(a), end(c));
      if (tt >= c.start && tt < ovEnd) {
        const p = (tt - c.start) / Math.max(0.001, ovEnd - c.start);
        switch (c.transType) {
          case "crossfade": opacity *= p; break;
          case "dipBlack": opacity *= Math.max(0, 2 * p - 1); break;
          case "slideL": offX += (1 - p); break;
          case "slideR": offX += -(1 - p); break;
          case "slideUp": offY += (1 - p); break;
          case "zoom": scaleMul *= 0.2 + 0.8 * p; opacity *= p; break;
          case "wipe": reveal = p; break;
        }
      }
    }
  }
  // outgoing (c is A): a next clip with a transition overlaps our tail
  const b = nextTransOverlap(c, all);
  if (b) {
    const ovEnd = Math.min(end(c), end(b));
    if (tt >= b.start && tt < ovEnd) {
      const p = (tt - b.start) / Math.max(0.001, ovEnd - b.start);
      if (b.transType === "crossfade" || b.transType === "zoom") opacity *= (1 - p);
      else if (b.transType === "dipBlack") opacity *= (1 - Math.min(1, 2 * p));
      // slide/wipe: outgoing stays put, incoming moves/wipes over it
    }
  }
  return { opacity, scaleMul, offX, offY, reveal };
}
