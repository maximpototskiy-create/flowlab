// Shared track-correction math used by both the Screen Replace track editor and
// the timeline editor's live preview, so the two always agree frame-for-frame.
// Keys store per-corner offsets `c` = [[dx,dy] x4] from the auto-track quad at
// the key's frame. Modes: see correctedQuadAt.

export type TrackMode = "region" | "keys" | "anchor";
export type TrackKeyC = { t: number; c: number[][] };

// Hermite interpolation of a per-corner point set P across the keyed range.
// Interior tangents are time-aware Catmull-Rom; the two end tangents are the
// auto-track velocity (useAutoVel — a smooth handoff for "region") or a
// one-sided difference (otherwise).
export function interpPts(
  quads: number[][][],
  P: number[][][],
  keys: TrackKeyC[],
  kf: number[],
  f: number,
  N: number,
  useAutoVel: boolean,
): number[][] {
  const n = keys.length;
  const tNow = f / (N - 1);
  let i = 0;
  for (let k = 0; k < n - 1; k++) { if (f >= kf[k] && f <= kf[k + 1]) { i = k; break; } }
  const ti = keys[i].t, tj = keys[i + 1].t, h = Math.max(tj - ti, 1e-6);
  let s = (tNow - ti) / h; s = s < 0 ? 0 : s > 1 ? 1 : s;
  const h00 = 2 * s * s * s - 3 * s * s + 1, h10 = s * s * s - 2 * s * s + s, h01 = -2 * s * s * s + 3 * s * s, h11 = s * s * s - s * s;
  const autoVel = (g: number, cc: number, d: number) => {
    const a = Math.max(0, g - 1), b = Math.min(N - 1, g + 1);
    return (quads[b][cc][d] - quads[a][cc][d]) / ((b - a) / (N - 1) || 1e-6);
  };
  const out: number[][] = [[0, 0], [0, 0], [0, 0], [0, 0]];
  for (let cc = 0; cc < 4; cc++) for (let d = 0; d < 2; d++) {
    const pI = P[i][cc][d], pJ = P[i + 1][cc][d];
    const mI = i > 0 ? (pJ - P[i - 1][cc][d]) / (tj - keys[i - 1].t) : (useAutoVel ? autoVel(kf[0], cc, d) : (pJ - pI) / h);
    const mJ = i + 1 < n - 1 ? (P[i + 2][cc][d] - pI) / (keys[i + 2].t - ti) : (useAutoVel ? autoVel(kf[n - 1], cc, d) : (pJ - pI) / h);
    out[cc][d] = h00 * pI + h10 * h * mI + h01 * pJ + h11 * h * mJ;
  }
  return out;
}

// Corrected screen quad at frame f, per mode:
//   "region" — keys define the screen INSIDE the keyed span via a smooth absolute
//     path (auto-track jitter between keys ignored); pure auto-track OUTSIDE.
//   "keys"   — smooth absolute path through the keys across the WHOLE clip;
//     auto-track ignored; held before first / after last key.
//   "anchor" — auto-track everywhere PLUS a smooth keyed offset (held outside).
export function correctedQuadAt(quads: number[][][], keys: TrackKeyC[], f: number, mode: TrackMode): number[][] {
  const N = quads.length;
  const q = quads[Math.max(0, Math.min(N - 1, f))];
  if (!keys.length || N < 2) return q;
  const n = keys.length;
  const kf = keys.map((k) => Math.max(0, Math.min(N - 1, Math.round(k.t * (N - 1)))));
  if (mode === "anchor") {
    let off: number[][];
    if (n === 1 || f <= kf[0]) off = keys[0].c;
    else if (f >= kf[n - 1]) off = keys[n - 1].c;
    else off = interpPts(quads, keys.map((k) => k.c), keys, kf, f, N, false);
    return q.map((p, ci) => [p[0] + off[ci][0], p[1] + off[ci][1]]);
  }
  const T = keys.map((k, ki) => quads[kf[ki]].map((p, ci) => [p[0] + k.c[ci][0], p[1] + k.c[ci][1]]));
  if (f < kf[0]) return mode === "keys" ? T[0] : q;
  if (f > kf[n - 1]) return mode === "keys" ? T[n - 1] : q;
  if (n === 1) return T[0];
  return interpPts(quads, T, keys, kf, f, N, mode === "region");
}

// ── corner-pin (perspective) ──────────────────────────────────────────────
// Build a CSS matrix3d (column-major, 16 numbers) that maps a W×H rectangle
// (origin top-left) onto the quad [TL, TR, BR, BL]. Apply with
// transform-origin: 0 0. Validated: rect corners land exactly on the quad.
function adj3(m: number[]): number[] {
  return [
    m[4] * m[8] - m[5] * m[7], m[2] * m[7] - m[1] * m[8], m[1] * m[5] - m[2] * m[4],
    m[5] * m[6] - m[3] * m[8], m[0] * m[8] - m[2] * m[6], m[2] * m[3] - m[0] * m[5],
    m[3] * m[7] - m[4] * m[6], m[1] * m[6] - m[0] * m[7], m[0] * m[4] - m[1] * m[3],
  ];
}
function mul3(a: number[], b: number[]): number[] {
  const r: number[] = [];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) { let s = 0; for (let k = 0; k < 3; k++) s += a[i * 3 + k] * b[k * 3 + j]; r[i * 3 + j] = s; }
  return r;
}
function mulV3(m: number[], v: number[]): number[] {
  return [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
}
function basisToPoints(p1: number[], p2: number[], p3: number[], p4: number[]): number[] {
  const m = [p1[0], p2[0], p3[0], p1[1], p2[1], p3[1], 1, 1, 1];
  const v = mulV3(adj3(m), [p4[0], p4[1], 1]);
  return mul3(m, [v[0], 0, 0, 0, v[1], 0, 0, 0, v[2]]);
}
export function cornerPinMatrix3d(W: number, H: number, quad: number[][]): number[] {
  const s = basisToPoints([0, 0], [W, 0], [W, H], [0, H]);
  const d = basisToPoints(quad[0], quad[1], quad[2], quad[3]);
  const t = mul3(d, adj3(s));
  for (let i = 0; i < 9; i++) t[i] = t[i] / t[8];
  return [t[0], t[3], 0, t[6], t[1], t[4], 0, t[7], 0, 0, 1, 0, t[2], t[5], 0, t[8]];
}
