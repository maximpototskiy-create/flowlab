// ─────────────────────────────────────────────────────────────────────────
// Short-video workaround. Marengo requires video ≥ 4s. Many hooks are shorter,
// so when an embed fails with "video_duration_too_short" we pad the clip to
// ≥4s by freezing the last frame (ffmpeg tpad), re-upload the padded copy, and
// embed that. The brand asset keeps pointing at the ORIGINAL file for preview;
// only the embedding is computed from the padded version.
// ─────────────────────────────────────────────────────────────────────────
import { spawn } from "child_process";
import { writeFile, readFile, unlink, mkdtemp, mkdir, readdir, rm, stat } from "fs/promises";
import { existsSync } from "fs";
import os from "os";
import path from "path";
import ffmpegPath from "ffmpeg-static";
import sharp from "sharp";
import type { Graph, GraphNode } from "@/lib/canvas/types";


import { uploadBytes } from "@/lib/storage";
import { embedVideo } from "@/lib/twelvelabs/embed";

function resolveFfmpeg(): string {
  // ffmpeg-static returns the bundled binary path; fall back to PATH locally.
  if (ffmpegPath && existsSync(ffmpegPath as unknown as string)) return ffmpegPath as unknown as string;
  return "ffmpeg";
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const bin = resolveFfmpeg();
    const proc = spawn(bin, args);
    let err = "";
    proc.stderr.on("data", (d) => {
      err += d.toString();
    });
    proc.on("error", (e: NodeJS.ErrnoException) =>
      reject(new Error(e.code === "ENOENT" ? "ffmpeg binary missing in deployment" : e.message)),
    );
    proc.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${err.slice(-300)}`))));
  });
}

// Like runFfmpeg but returns the process so we can stream raw frames into its
// stdin. Used by the compositor to avoid writing any frames to disk — at high
// res / 50fps that overflows /tmp ("No space left on device").
function spawnFfmpeg(args: string[]): { proc: ReturnType<typeof spawn>; done: Promise<void> } {
  const bin = resolveFfmpeg();
  const proc = spawn(bin, args);
  let err = "";
  proc.stderr.on("data", (d) => {
    err += d.toString();
  });
  const done = new Promise<void>((resolve, reject) => {
    proc.on("error", (e: NodeJS.ErrnoException) =>
      reject(new Error(e.code === "ENOENT" ? "ffmpeg binary missing in deployment" : e.message)),
    );
    proc.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${err.slice(-300)}`))));
  });
  return { proc, done };
}

// Decode source frames as raw RGB on a pipe and hand them out one at a time.
// We never materialise the frames as files: a 50fps clip is hundreds of frames
// and writing them all to the small serverless /tmp overflows it ("No space
// left on device"). Backpressure is automatic — ffmpeg blocks when we stop
// pulling. next() returns a W*H*3 Buffer per frame, or null at end of stream.
function openFrameStream(srcPath: string, frameSize: number): { next: () => Promise<Buffer | null>; destroy: () => void } {
  const proc = spawn(resolveFfmpeg(), ["-i", srcPath, "-f", "rawvideo", "-pix_fmt", "rgb24", "-loglevel", "error", "pipe:1"]);
  let stderr = "";
  proc.stderr.on("data", (d) => {
    stderr += d.toString();
  });
  const stdout = proc.stdout;
  let stash: Buffer | null = null; // bytes already read that belong to the next frame
  let ended = false;
  let errored: Error | null = null;
  stdout.on("end", () => {
    ended = true;
  });
  proc.on("error", (e: NodeJS.ErrnoException) => {
    errored = new Error(e.code === "ENOENT" ? "ffmpeg binary missing in deployment" : e.message);
    ended = true;
  });
  proc.on("close", (code) => {
    if (code) errored = errored ?? new Error(`ffmpeg decode exited ${code}: ${stderr.slice(-300)}`);
    ended = true;
  });
  async function next(): Promise<Buffer | null> {
    // Assemble exactly one frame into a pre-allocated buffer (O(frameSize)).
    // The old `Buffer.concat` per chunk was O(n^2): a 6MB frame arrives as ~100
    // small pipe chunks, and re-concatenating the growing buffer each time
    // copied hundreds of MB per frame and thrashed the GC — that was the real
    // reason long clips crawled.
    const frame = Buffer.allocUnsafe(frameSize);
    let filled = 0;
    if (stash) {
      const take = Math.min(stash.length, frameSize);
      stash.copy(frame, 0, 0, take);
      filled = take;
      stash = take < stash.length ? stash.subarray(take) : null;
    }
    while (filled < frameSize) {
      if (errored) throw errored;
      const chunk = stdout.read() as Buffer | null;
      if (chunk) {
        const take = Math.min(chunk.length, frameSize - filled);
        chunk.copy(frame, filled, 0, take);
        filled += take;
        if (take < chunk.length) stash = chunk.subarray(take);
        continue;
      }
      if (ended) break;
      await new Promise<void>((resolve) => {
        const on = () => {
          cleanup();
          resolve();
        };
        const cleanup = () => {
          stdout.off("readable", on);
          stdout.off("end", on);
          proc.off("close", on);
        };
        stdout.once("readable", on);
        stdout.once("end", on);
        proc.once("close", on);
      });
    }
    if (filled < frameSize) {
      if (errored) throw errored;
      return null;
    }
    return frame;
  }
  function destroy() {
    try {
      proc.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
  return { next, destroy };
}

// Reclaim disk from temp dirs leaked by earlier runs that were hard-killed
// (OOM / function timeout) before their `finally` cleanup could run. On warm
// (Fluid) compute these "sr_*" dirs pile up in /tmp until even a small frame
// extraction fails with "No space left on device". A normal compositing pass
// finishes in well under a minute, so any sibling dir older than 2 minutes is
// stale and safe to remove. Never touches the current run's own dir.
async function sweepStaleScreenReplaceTemp(selfDir: string): Promise<void> {
  try {
    const base = os.tmpdir();
    const now = Date.now();
    const names = await readdir(base);
    await Promise.all(
      names
        .filter((n) => n.startsWith("sr_"))
        .map((n) => path.join(base, n))
        .filter((p) => p !== selfDir)
        .map(async (p) => {
          try {
            const st = await stat(p);
            if (now - st.mtimeMs > 120_000) await rm(p, { recursive: true, force: true });
          } catch {
            /* ignore — another worker may be removing it concurrently */
          }
        }),
    );
  } catch {
    /* best-effort: never fail the run because cleanup hiccuped */
  }
}

// Quick probe of a video's dimensions + fps by parsing ffmpeg's stderr banner
// (ffmpeg-static ships no ffprobe). Good enough for compositing math.
function ffprobeBasic(inPath: string): Promise<{ width: number; height: number; fps: number }> {
  return new Promise((resolve) => {
    const proc = spawn(resolveFfmpeg(), ["-i", inPath]);
    let err = "";
    proc.stderr.on("data", (d) => (err += d.toString()));
    proc.on("error", () => resolve({ width: 0, height: 0, fps: 30 }));
    proc.on("close", () => {
      const dim = err.match(/,\s*(\d{2,5})x(\d{2,5})[\s,]/);
      const fpsM = err.match(/([\d.]+)\s*fps/);
      resolve({
        width: dim ? parseInt(dim[1], 10) : 0,
        height: dim ? parseInt(dim[2], 10) : 0,
        fps: fpsM ? Math.max(1, Math.round(parseFloat(fpsM[1]))) : 30,
      });
    });
  });
}

type Pt = [number, number];
type GQuad = [Pt, Pt, Pt, Pt] | null;

// Solve a 3x3 homography mapping src[i] -> dst[i] (4 correspondences, h33=1)
// via direct linear solve (Gaussian elimination on the 8x8 system).
function solveHomography(src: Pt[], dst: Pt[]): number[] {
  const A: number[][] = [], b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i], [X, Y] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -x * X, -y * X]); b.push(X);
    A.push([0, 0, 0, x, y, 1, -x * Y, -y * Y]); b.push(Y);
  }
  const n = 8;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]]; [b[c], b[p]] = [b[p], b[c]];
    const pv = A[c][c];
    if (Math.abs(pv) < 1e-9) continue;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = A[r][c] / pv;
      for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  const h: number[] = [];
  for (let i = 0; i < n; i++) h.push(b[i] / A[i][i]);
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

// Over-determined homography from N>=4 correspondences by least squares (normal
// equations of the 2N x 8 DLT system). With many marker points the per-marker
// centroid noise averages out, so the recovered screen corners are far steadier
// than a 4-point exact fit. Falls back to the exact solver for N==4.
function solveHomographyLSQ(src: Pt[], dst: Pt[]): number[] {
  const N = src.length;
  if (N < 4) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  if (N === 4) return solveHomography(src as Pt[], dst as Pt[]);
  // Build normal equations M (8x8) and rhs (8) from rows of A.
  const M: number[][] = Array.from({ length: 8 }, () => new Array(8).fill(0));
  const rhs: number[] = new Array(8).fill(0);
  const addRow = (row: number[], val: number) => {
    for (let i = 0; i < 8; i++) {
      rhs[i] += row[i] * val;
      for (let j = 0; j < 8; j++) M[i][j] += row[i] * row[j];
    }
  };
  for (let k = 0; k < N; k++) {
    const [x, y] = src[k], [X, Y] = dst[k];
    addRow([x, y, 1, 0, 0, 0, -x * X, -y * X], X);
    addRow([0, 0, 0, x, y, 1, -x * Y, -y * Y], Y);
  }
  // Solve M h = rhs (8x8) via Gaussian elimination with partial pivoting.
  const n = 8;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]]; [rhs[c], rhs[p]] = [rhs[p], rhs[c]];
    const pv = M[c][c];
    if (Math.abs(pv) < 1e-12) continue;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / pv;
      for (let j = c; j < n; j++) M[r][j] -= f * M[c][j];
      rhs[r] -= f * rhs[c];
    }
  }
  const h: number[] = [];
  for (let i = 0; i < n; i++) h.push(M[i][i] !== 0 ? rhs[i] / M[i][i] : 0);
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

const isGreen = (data: Buffer, i: number) => {
  const r = data[i], g = data[i + 1], b = data[i + 2];
  return g > 80 && g > r * 1.4 && g > b * 1.4;
};


// Normalized unit-square corners (TL, TR, BR, BL) — the screen rectangle in
// template space. Marker centroids sit at a fractional inset from these; that
// inset is AUTO-CALIBRATED per clip (see below), because how far the rendered
// dark-green markers land from the screen edge depends on how HeyGen fit the
// template into the phone screen and so varies between source videos.
const TMPL_CORNERS: Pt[] = [[0, 0], [1, 0], [1, 1], [0, 1]];

// Interior tracking-dot grid, in the SAME normalized screen coords (the screen
// rectangle is [0,1] x [0,1]). The denser template (4 corner markers + this
// grid of small dark-green dots) lets the tracker fit an OVER-DETERMINED
// homography from ~24 points instead of 4, so centroid noise averages out and
// the corners stop floating. These positions MUST match the generated template
// PNG. Backward compatible: on the old 4-marker template no interior dots are
// found and we fall back to the 4-corner fit.
const INTERIOR_TMPL: Pt[] = (() => {
  const xs = [0.28, 0.44, 0.56, 0.72], ys = [0.20, 0.34, 0.48, 0.62, 0.76];
  const out: Pt[] = [];
  for (const y of ys) for (const x of xs) out.push([x, y]);
  return out;
})();

// Largest 4-connected blob of a color test inside a sub-rectangle that is also
// COMPACT (area / bbox-area >= minFill). The compactness gate rejects the thin
// dark-green ring along the screen-bezel edge transition (a long, thin blob)
// while keeping the solid square markers. Returns centroid or null.
function blobCentroidCompact(
  data: Buffer, W: number, ch: number,
  test: (r: number, g: number, b: number) => boolean,
  weight: (r: number, g: number, b: number) => number,
  qx0: number, qy0: number, qx1: number, qy1: number, minPx: number, minFill: number,
): Pt | null {
  const cols = qx1 - qx0 + 1, rows = qy1 - qy0 + 1;
  if (cols <= 0 || rows <= 0) return null;
  const seen = new Uint8Array(cols * rows);
  const stack: number[] = [];
  const ok = (x: number, y: number) => {
    const i = (y * W + x) * ch;
    return test(data[i], data[i + 1], data[i + 2]);
  };
  // Track the largest compact blob, but localise its centre with an INTENSITY-
  // WEIGHTED centroid (weight = how strongly "marker", i.e. dark below the
  // screen level). Pixels at the detection threshold get weight ~0, so as they
  // flicker in/out of the binary mask frame-to-frame they barely move the
  // centre — this is what kills the ~0.5px sub-pixel detection jitter at source.
  let bestN = 0, bestCx = 0, bestCy = 0;
  for (let y = qy0; y <= qy1; y++) {
    for (let x = qx0; x <= qx1; x++) {
      const li = (y - qy0) * cols + (x - qx0);
      if (seen[li] || !ok(x, y)) continue;
      let n = 0, ws = 0, wsx = 0, wsy = 0, sx = 0, sy = 0, minx = x, maxx = x, miny = y, maxy = y;
      seen[li] = 1; stack.length = 0; stack.push(y * W + x);
      while (stack.length) {
        const gI = stack.pop()!; const cx = gI % W, cy = (gI / W) | 0;
        n++; sx += cx; sy += cy;
        const pi = (cy * W + cx) * ch;
        const w = weight(data[pi], data[pi + 1], data[pi + 2]);
        if (w > 0) { ws += w; wsx += w * cx; wsy += w * cy; }
        if (cx < minx) minx = cx; if (cx > maxx) maxx = cx;
        if (cy < miny) miny = cy; if (cy > maxy) maxy = cy;
        if (cx + 1 <= qx1) { const nx = cx + 1, l2 = (cy - qy0) * cols + (nx - qx0); if (!seen[l2] && ok(nx, cy)) { seen[l2] = 1; stack.push(cy * W + nx); } }
        if (cx - 1 >= qx0) { const nx = cx - 1, l2 = (cy - qy0) * cols + (nx - qx0); if (!seen[l2] && ok(nx, cy)) { seen[l2] = 1; stack.push(cy * W + nx); } }
        if (cy + 1 <= qy1) { const ny = cy + 1, l2 = (ny - qy0) * cols + (cx - qx0); if (!seen[l2] && ok(cx, ny)) { seen[l2] = 1; stack.push(ny * W + cx); } }
        if (cy - 1 >= qy0) { const ny = cy - 1, l2 = (ny - qy0) * cols + (cx - qx0); if (!seen[l2] && ok(cx, ny)) { seen[l2] = 1; stack.push(ny * W + cx); } }
      }
      if (n < minPx) continue;
      const fill = n / ((maxx - minx + 1) * (maxy - miny + 1));
      if (fill < minFill) continue;
      if (n > bestN) { bestN = n; bestCx = ws > 0 ? wsx / ws : sx / n; bestCy = ws > 0 ? wsy / ws : sy / n; }
    }
  }
  return bestN > 0 ? [bestCx, bestCy] : null;
}

// Detect the 4 DARK-GREEN corner markers; returns their centroids [TL,TR,BR,BL]
// in image coords, or null if any isn't cleanly present (-> green-edge
// fallback). Found by CONTRAST: within the bright-green bbox a per-frame
// ADAPTIVE threshold (relative to the screen's own green level -> exposure
// robust) selects green-dominant-but-dark pixels; a compact-blob search per
// corner quadrant isolates each square marker from the thin dark-green edge
// ring. Dark-green keys out with the chroma key automatically and never
// collides with arbitrary scene colors, which is what makes it production-safe.
function detectMarkers(
  data: Buffer, W: number, H: number, ch: number, bbox: [number, number, number, number],
): [Pt, Pt, Pt, Pt] | null {
  const [bx0, by0, bx1, by1] = bbox;
  const bw = bx1 - bx0, bh = by1 - by0;
  if (bw < 20 || bh < 20) return null;
  const gh = new Uint32Array(256);
  let gcount = 0;
  for (let y = by0; y <= by1; y++) {
    for (let x = bx0; x <= bx1; x++) {
      const i = (y * W + x) * ch; const r = data[i], g = data[i + 1], b = data[i + 2];
      if (g > 20 && g > r * 1.3 && g > b * 1.3) { gh[g]++; gcount++; }
    }
  }
  if (gcount < 100) return null;
  let acc = 0, screenG = 200;
  for (let v = 0; v < 256; v++) { acc += gh[v]; if (acc * 2 >= gcount) { screenG = v; break; } }
  const darkMax = 0.55 * screenG, darkMin = 0.10 * screenG;
  const tDG = (r: number, g: number, b: number) => g > r * 1.25 && g > b * 1.25 && g < darkMax && g > darkMin;
  // Sub-pixel weight: within the dark-green gate, darker (more central to the
  // solid marker) = higher weight; pixels near darkMax (the bezel-side boundary
  // that flickers across the threshold) tend to ~0 weight and so don't jitter
  // the centroid.
  const wDG = (_r: number, g: number, _b: number) => darkMax - g;
  const minPx = Math.max(20, 0.0006 * bw * bh);
  // Corner search windows = the OUTER 42% of each side, NOT the full half. A
  // dense marker pattern can have a large marker near the screen CENTRE (e.g. an
  // asymmetry/orientation mark); at half-size the quadrants meet at the centre
  // and that central marker, being large, gets picked as a "corner", skewing the
  // whole fit. Shrinking to 0.42 leaves a cross-shaped gap in the middle so a
  // central marker is excluded, while true corner markers (hard against the
  // corners) stay well inside their window. Sparse templates are unaffected.
  const qw = Math.round(0.42 * bw), qh = Math.round(0.42 * bh);
  const tl = blobCentroidCompact(data, W, ch, tDG, wDG, bx0, by0, bx0 + qw, by0 + qh, minPx, 0.45);
  const tr = blobCentroidCompact(data, W, ch, tDG, wDG, bx1 - qw, by0, bx1, by0 + qh, minPx, 0.45);
  const br = blobCentroidCompact(data, W, ch, tDG, wDG, bx1 - qw, by1 - qh, bx1, by1, minPx, 0.45);
  const bl = blobCentroidCompact(data, W, ch, tDG, wDG, bx0, by1 - qh, bx0 + qw, by1, minPx, 0.45);
  if (!tl || !tr || !br || !bl) return null;
  return [tl, tr, br, bl];
}

// Local marker inset (fraction from the NEAREST screen edge) measured against
// the BRIGHT-green extent on the marker's own row/column. Tilt-invariant, so
// averaged over the clip it recovers exactly how far the rendered markers sit
// from the screen edge for THIS source -> per-clip auto-calibration. Pushes up
// to 4 horizontal and 4 vertical samples per frame.
function sampleMarkerInset(
  data: Buffer, W: number, ch: number,
  bbox: [number, number, number, number], cents: [Pt, Pt, Pt, Pt],
  outH: number[], outV: number[],
): void {
  const [bx0, by0, bx1, by1] = bbox;
  const isBright = (x: number, y: number) => {
    const i = (y * W + x) * ch; const r = data[i], g = data[i + 1], b = data[i + 2];
    return g > 110 && g > r * 1.4 && g > b * 1.4;
  };
  for (let k = 0; k < 4; k++) {
    const cx = cents[k][0], cy = cents[k][1];
    const ix = Math.round(cx), iy = Math.round(cy);
    let xl = -1, xr = -1;
    for (let x = bx0; x <= bx1; x++) { if (isBright(x, iy)) { if (xl < 0) xl = x; xr = x; } }
    if (xl >= 0 && xr > xl) { const f = (cx - xl) / (xr - xl); outH.push(k === 0 || k === 3 ? f : 1 - f); }
    let yt = -1, yb = -1;
    for (let y = by0; y <= by1; y++) { if (isBright(ix, y)) { if (yt < 0) yt = y; yb = y; } }
    if (yt >= 0 && yb > yt) { const f = (cy - yt) / (yb - yt); outV.push(k === 0 || k === 1 ? f : 1 - f); }
  }
}

// Extrapolate the 4 screen corners from detected marker centroids using the
// per-clip calibrated marker inset: homography from the calibrated normalized
// marker positions to the detected centroids, then project the unit-square
// corners. Returns null on a degenerate/implausible solution.
function screenFromMarkers(
  cents: [Pt, Pt, Pt, Pt], calibTMPL: Pt[], bbox: [number, number, number, number],
): [Pt, Pt, Pt, Pt] | null {
  const Hm = solveHomography(calibTMPL, cents);
  const proj = (p: Pt): Pt => {
    const w = Hm[6] * p[0] + Hm[7] * p[1] + Hm[8];
    return [(Hm[0] * p[0] + Hm[1] * p[1] + Hm[2]) / w, (Hm[3] * p[0] + Hm[4] * p[1] + Hm[5]) / w];
  };
  const out = TMPL_CORNERS.map(proj) as [Pt, Pt, Pt, Pt];
  const [bx0, by0, bx1, by1] = bbox; const bw = bx1 - bx0, bh = by1 - by0;
  for (const [x, y] of out) {
    if (!isFinite(x) || !isFinite(y) || x < bx0 - bw || x > bx1 + bw || y < by0 - bh || y > by1 + bh) return null;
  }
  return out;
}

// Find ALL compact dark-green blobs (corner markers + the interior tracking
// dots) inside the screen bbox, each as a sub-pixel weighted centroid. Same
// adaptive dark-green gate as detectMarkers; a single connected-components pass
// over the bbox. Used to build an over-determined homography from many points.
function detectDarkGreenBlobs(
  data: Buffer, W: number, ch: number, bbox: [number, number, number, number],
): Pt[] {
  const [bx0, by0, bx1, by1] = bbox;
  const bw = bx1 - bx0, bh = by1 - by0;
  if (bw < 20 || bh < 20) return [];
  const gh = new Uint32Array(256);
  let gcount = 0;
  for (let y = by0; y <= by1; y++) {
    for (let x = bx0; x <= bx1; x++) {
      const i = (y * W + x) * ch; const r = data[i], g = data[i + 1], b = data[i + 2];
      if (g > 20 && g > r * 1.3 && g > b * 1.3) { gh[g]++; gcount++; }
    }
  }
  if (gcount < 100) return [];
  let acc = 0, screenG = 200;
  for (let v = 0; v < 256; v++) { acc += gh[v]; if (acc * 2 >= gcount) { screenG = v; break; } }
  const darkMax = 0.55 * screenG, darkMin = 0.10 * screenG;
  const test = (r: number, g: number, b: number) => g > r * 1.25 && g > b * 1.25 && g < darkMax && g > darkMin;
  const minPx = Math.max(20, 0.00006 * bw * bh); // small enough for interior dots
  const cols = bw + 1, rows = bh + 1;
  const seen = new Uint8Array(cols * rows);
  const stack: number[] = [];
  const ok = (x: number, y: number) => { const i = (y * W + x) * ch; return test(data[i], data[i + 1], data[i + 2]); };
  const blobs: Pt[] = [];
  for (let y = by0; y <= by1; y++) {
    for (let x = bx0; x <= bx1; x++) {
      const li = (y - by0) * cols + (x - bx0);
      if (seen[li] || !ok(x, y)) continue;
      let n = 0, ws = 0, wsx = 0, wsy = 0, sx = 0, sy = 0, minx = x, maxx = x, miny = y, maxy = y;
      seen[li] = 1; stack.length = 0; stack.push(y * W + x);
      while (stack.length) {
        const gI = stack.pop()!; const cx = gI % W, cy = (gI / W) | 0;
        n++; sx += cx; sy += cy;
        const pi = (cy * W + cx) * ch; const wgt = darkMax - data[pi + 1];
        if (wgt > 0) { ws += wgt; wsx += wgt * cx; wsy += wgt * cy; }
        if (cx < minx) minx = cx; if (cx > maxx) maxx = cx;
        if (cy < miny) miny = cy; if (cy > maxy) maxy = cy;
        if (cx + 1 <= bx1) { const nx = cx + 1, l2 = (cy - by0) * cols + (nx - bx0); if (!seen[l2] && ok(nx, cy)) { seen[l2] = 1; stack.push(cy * W + nx); } }
        if (cx - 1 >= bx0) { const nx = cx - 1, l2 = (cy - by0) * cols + (nx - bx0); if (!seen[l2] && ok(nx, cy)) { seen[l2] = 1; stack.push(cy * W + nx); } }
        if (cy + 1 <= by1) { const ny = cy + 1, l2 = (ny - by0) * cols + (cx - bx0); if (!seen[l2] && ok(cx, ny)) { seen[l2] = 1; stack.push(ny * W + cx); } }
        if (cy - 1 >= by0) { const ny = cy - 1, l2 = (ny - by0) * cols + (cx - bx0); if (!seen[l2] && ok(cx, ny)) { seen[l2] = 1; stack.push(ny * W + cx); } }
      }
      if (n < minPx) continue;
      const fill = n / ((maxx - minx + 1) * (maxy - miny + 1));
      if (fill < 0.4) continue; // compact only (rejects the thin bezel-edge ring)
      blobs.push(ws > 0 ? [wsx / ws, wsy / ws] : [sx / n, sy / n]);
    }
  }
  return blobs;
}

// Over-determined screen corners: bootstrap a homography from the 4 corner
// markers, project the known interior dot grid, match each to the nearest
// detected blob, then refit the homography from ALL matched points (corners +
// dots) by least squares and project the screen corners. Returns null if too
// few interior dots are matched (e.g. the old 4-marker template) so the caller
// can fall back to the plain 4-corner fit.
function screenFromGrid(
  cents: [Pt, Pt, Pt, Pt], blobs: Pt[], calibTMPL: Pt[], bbox: [number, number, number, number],
  seedH?: number[] | null, interiorTmpl: Pt[] = INTERIOR_TMPL,
): { quad: [Pt, Pt, Pt, Pt]; H: number[] } | null {
  if (blobs.length < 8) return null;
  const H0 = seedH ?? solveHomography(calibTMPL, cents);
  const proj0 = (p: Pt): Pt => {
    const w = H0[6] * p[0] + H0[7] * p[1] + H0[8];
    return [(H0[0] * p[0] + H0[1] * p[1] + H0[2]) / w, (H0[3] * p[0] + H0[4] * p[1] + H0[5]) / w];
  };
  const sp = Math.hypot(cents[1][0] - cents[0][0], cents[1][1] - cents[0][1]) || (bbox[2] - bbox[0]); // ~screen width px
  // Match ALL template points (4 corners + interior grid) to detected blobs via
  // the H0 prediction. With a temporal seed (previous frame's H), the prediction
  // is correct even when a finger covers a corner — the covered point simply
  // finds no blob and is skipped, instead of corrupting the fit.
  const used = new Array(blobs.length).fill(false);
  let src: Pt[] = [];
  let dst: Pt[] = [];
  const allTmpl: Pt[] = [calibTMPL[0], calibTMPL[1], calibTMPL[2], calibTMPL[3], ...interiorTmpl];
  const projected = allTmpl.map(proj0);
  // Adaptive match radius: never match a template point across more than ~half
  // the spacing to its nearest neighbour, so a DENSE marker grid can't snap a
  // template point onto an ADJACENT marker (which silently corrupts the fit).
  // Sparse templates keep the generous radius.
  const nn: number[] = [];
  for (let a = 0; a < projected.length; a++) {
    let bd = Infinity;
    for (let b = 0; b < projected.length; b++) { if (a === b) continue; const d = Math.hypot(projected[a][0] - projected[b][0], projected[a][1] - projected[b][1]); if (d < bd) bd = d; }
    if (isFinite(bd)) nn.push(bd);
  }
  const tol = Math.min(0.085 * sp, nn.length ? 0.45 * median(nn) : 0.085 * sp);
  for (let t = 0; t < allTmpl.length; t++) {
    const pp = projected[t];
    let bi = -1, bd = Infinity;
    for (let k = 0; k < blobs.length; k++) { if (used[k]) continue; const d = Math.hypot(blobs[k][0] - pp[0], blobs[k][1] - pp[1]); if (d < bd) { bd = d; bi = k; } }
    if (bi >= 0 && bd < tol) { used[bi] = true; src.push(allTmpl[t]); dst.push(blobs[bi]); }
  }
  if (src.length < 6) return null; // not a grid template — use the 4-corner fit
  let H = solveHomographyLSQ(src, dst);
  // One round of robust reweighting: a covered/false corner can still slip in as
  // a match; drop pairs whose reprojection residual is far above the median and
  // re-fit, so a single bad point can't skew the homography.
  {
    const pr = (p: Pt): Pt => { const w = H[6] * p[0] + H[7] * p[1] + H[8]; return [(H[0] * p[0] + H[1] * p[1] + H[2]) / w, (H[3] * p[0] + H[4] * p[1] + H[5]) / w]; };
    const res = src.map((s2, idx) => { const q = pr(s2); return Math.hypot(q[0] - dst[idx][0], q[1] - dst[idx][1]); });
    const med = median(res) || tol;
    const ks: Pt[] = [], kd: Pt[] = [];
    for (let idx = 0; idx < src.length; idx++) { if (res[idx] <= Math.max(0.5 * tol, 2.5 * med)) { ks.push(src[idx]); kd.push(dst[idx]); } }
    if (ks.length >= 8 && ks.length < src.length) { src = ks; dst = kd; H = solveHomographyLSQ(src, dst); }
  }
  const proj = (p: Pt): Pt => {
    const w = H[6] * p[0] + H[7] * p[1] + H[8];
    return [(H[0] * p[0] + H[1] * p[1] + H[2]) / w, (H[3] * p[0] + H[4] * p[1] + H[5]) / w];
  };
  const out = TMPL_CORNERS.map(proj) as [Pt, Pt, Pt, Pt];
  const [bx0, by0, bx1, by1] = bbox; const bw = bx1 - bx0, bh = by1 - by0;
  for (const [x, y] of out) {
    if (!isFinite(x) || !isFinite(y) || x < bx0 - bw || x > bx1 + bw || y < by0 - bh || y > by1 + bh) return null;
  }
  return { quad: out, H };
}

type GComp = { quad: [Pt, Pt, Pt, Pt]; bbox: [number, number, number, number]; size: number };

// Least-squares line fit. vertical=true fits x = m*y + c (for the left/right
// screen edges); false fits y = m*x + c (top/bottom edges).
function fitLine(pts: Pt[], vertical: boolean): { m: number; c: number; vertical: boolean } {
  const n = pts.length;
  if (n < 2) return { m: 0, c: vertical ? pts[0]?.[0] ?? 0 : pts[0]?.[1] ?? 0, vertical };
  let sa = 0, sb = 0, saa = 0, sab = 0;
  for (const [x, y] of pts) {
    const a = vertical ? y : x, b = vertical ? x : y;
    sa += a; sb += b; saa += a * a; sab += a * b;
  }
  const m = (n * sab - sa * sb) / (n * saa - sa * sa + 1e-9);
  const c = (sb - m * sa) / n;
  return { m, c, vertical };
}

function lineIntersect(L1: { m: number; c: number; vertical: boolean }, L2: { m: number; c: number; vertical: boolean }): Pt {
  const V = L1.vertical ? L1 : L2;  // x = m*y + c
  const Hh = L1.vertical ? L2 : L1; // y = m*x + c
  const x = (V.m * Hh.c + V.c) / (1 - V.m * Hh.m + 1e-9);
  const y = Hh.m * x + Hh.c;
  return [x, y];
}

// Sub-pixel-stable corners by fitting straight lines to the screen's 4 edges
// (averaged over many edge pixels) and intersecting them. This is far steadier
// frame-to-frame than single extremal pixels, and the rounded corners + the top
// notch are excluded as outliers. Falls back to extremal corners if a fit fails.
function edgeFitCorners(
  lab: Int32Array, id: number, bbox: [number, number, number, number], W: number, H: number,
  fallback: [Pt, Pt, Pt, Pt],
): [Pt, Pt, Pt, Pt] {
  const [bx0, by0, bx1, by1] = bbox;
  const bw = bx1 - bx0, bh = by1 - by0;
  if (bw < 8 || bh < 8) return fallback;
  const isIn = (x: number, y: number) => x >= 0 && x < W && y >= 0 && y < H && lab[y * W + x] === id;
  const L: Pt[] = [], R: Pt[] = [];
  for (let y = Math.round(by0 + 0.15 * bh); y <= Math.round(by1 - 0.15 * bh); y++) {
    let lx = -1, rx = -1;
    for (let x = bx0; x <= bx1; x++) { if (isIn(x, y)) { if (lx < 0) lx = x; rx = x; } }
    if (lx >= 0) { L.push([lx, y]); R.push([rx, y]); }
  }
  const B: Pt[] = [];
  for (let x = Math.round(bx0 + 0.15 * bw); x <= Math.round(bx1 - 0.15 * bw); x++) {
    let by = -1;
    for (let y = by1; y >= by0; y--) { if (isIn(x, y)) { by = y; break; } }
    if (by >= 0) B.push([x, by]);
  }
  const topRaw: Pt[] = [];
  for (let x = Math.round(bx0 + 0.1 * bw); x <= Math.round(bx1 - 0.1 * bw); x++) {
    let ty = -1;
    for (let y = by0; y <= by1; y++) { if (isIn(x, y)) { ty = y; break; } }
    if (ty >= 0) topRaw.push([x, ty]);
  }
  if (L.length < 4 || R.length < 4 || B.length < 4 || topRaw.length < 4) return fallback;
  // Exclude the notch (columns whose top dips well below the median top).
  const tys = topRaw.map((p) => p[1]).sort((a, b) => a - b);
  const medTop = tys[(tys.length / 2) | 0];
  const T = topRaw.filter((p) => p[1] <= medTop + 15);
  if (T.length < 4) return fallback;
  const lL = fitLine(L, true), lR = fitLine(R, true), lT = fitLine(T, false), lB = fitLine(B, false);
  const tl = lineIntersect(lL, lT), tr = lineIntersect(lR, lT);
  const br = lineIntersect(lR, lB), bl = lineIntersect(lL, lB);
  // Sanity: corners must stay near the bbox; else the fit went wrong.
  for (const [x, y] of [tl, tr, br, bl]) {
    if (x < bx0 - bw || x > bx1 + bw || y < by0 - bh || y > by1 + bh || !isFinite(x) || !isFinite(y)) return fallback;
  }
  return [tl, tr, br, bl];
}

// Robust green-screen detection: label connected green regions and keep only
// the LARGEST one (the screen). This discards spill specks, compression noise
// and stray green objects in the background — the single biggest source of
// corner errors on real footage. Returns the screen's 4 corners (extremes of
// x±y on the cleaned blob), its axis-aligned bbox, and pixel count.
function greenComponent(data: Buffer, W: number, H: number, ch: number): GComp | null {
  const lab = new Int32Array(W * H);
  const stack: number[] = [];
  let cur = 0, bestId = 0, bestSize = 0;
  const comps: Record<number, GComp> = {};
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p = y * W + x;
      if (lab[p] === 0 && isGreen(data, p * ch)) {
        cur++;
        let size = 0, sm = Infinity, sx = -Infinity, dm = Infinity, dx = -Infinity;
        let tl: Pt = [x, y], tr: Pt = [x, y], br: Pt = [x, y], bl: Pt = [x, y];
        let mnx = x, mxx = x, mny = y, mxy = y;
        lab[p] = cur; stack.push(p);
        while (stack.length) {
          const q = stack.pop()!;
          const qx = q % W, qy = (q / W) | 0;
          size++;
          const s = qx + qy, d = qx - qy;
          if (s < sm) { sm = s; tl = [qx, qy]; }
          if (s > sx) { sx = s; br = [qx, qy]; }
          if (d > dx) { dx = d; tr = [qx, qy]; }
          if (d < dm) { dm = d; bl = [qx, qy]; }
          if (qx < mnx) mnx = qx; if (qx > mxx) mxx = qx;
          if (qy < mny) mny = qy; if (qy > mxy) mxy = qy;
          if (qx + 1 < W) { const n2 = q + 1; if (lab[n2] === 0 && isGreen(data, n2 * ch)) { lab[n2] = cur; stack.push(n2); } }
          if (qx - 1 >= 0) { const n2 = q - 1; if (lab[n2] === 0 && isGreen(data, n2 * ch)) { lab[n2] = cur; stack.push(n2); } }
          if (qy + 1 < H) { const n2 = q + W; if (lab[n2] === 0 && isGreen(data, n2 * ch)) { lab[n2] = cur; stack.push(n2); } }
          if (qy - 1 >= 0) { const n2 = q - W; if (lab[n2] === 0 && isGreen(data, n2 * ch)) { lab[n2] = cur; stack.push(n2); } }
        }
        comps[cur] = { quad: [tl, tr, br, bl], bbox: [mnx, mny, mxx, mxy], size };
        if (size > bestSize) { bestSize = size; bestId = cur; }
      }
    }
  }
  if (!bestId) return null;
  const best = comps[bestId];
  // Upgrade the extremal corners to edge-line-fit corners (sub-pixel stable).
  best.quad = edgeFitCorners(lab, bestId, best.bbox, W, H, best.quad);
  return best;
}

function quadArea(q: Pt[]): number {
  let a = 0;
  for (let i = 0; i < 4; i++) {
    const [x1, y1] = q[i], [x2, y2] = q[(i + 1) % 4];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

const median = (arr: number[]): number => {
  const s = [...arr].sort((a, b) => a - b);
  return s[(s.length / 2) | 0];
};

// Per-frame PLANAR-TRACKED chroma-key composite. The green screen's 4 corners
// are detected each frame and the inserted content (image OR video) is
// perspective-warped (homography + bilinear) onto that quad, so it follows the
// phone's position, scale AND tilt/perspective. The actual per-frame green
// pixels are the alpha, so fingers / phone body (non-green) stay on top. Strong
// motion blur or a screen that leaves frame will degrade gracefully.
export async function compositeGreenScreen(opts: {
  source: Buffer;
  content: Buffer;
  contentIsVideo: boolean;
  keyColorHex?: string; // kept for API symmetry; detection is generic-green
  similarity?: number;
  fit?: "fill" | "cover"; // how content maps onto the screen quad
  scaleX?: number; // per-axis scale of the content ON the screen (1 = auto-fit;
  scaleY?: number; // >1 zooms content in/bigger, <1 smaller). Fine-tunes fit.
  matteChoke?: number; // morphological matte edge in px: + spreads (content covers
                       // green fringe), - chokes (pulls content in). 0 = off.
  feather?: number;    // soft matte edge in px: blends content<->original over the
                       // edge instead of a hard cut. 0 = hard. Applied after choke.
  trackOffsetX?: number; // manual tracking correction: global px offset of the
  trackOffsetY?: number; // tracked screen quad (all frames).
  trackRotate?: number;  // global rotation (deg) of the quad about its centre.
  // Keyframed correction (Mocha-style). t in 0..1 (fraction of the clip). Linearly
  // interpolated per frame and ADDED to the global offset; frames between keys with
  // zero correction stay exactly as the auto-track. dx/dy px, rot deg.
  trackKeys?: { t: number; dx?: number; dy?: number; rot?: number }[];
}): Promise<Buffer> {
  const fit = opts.fit ?? "fill";
  // Clamp the on-screen scale to a sane range so a stray value can't invert/blow up.
  const clampScale = (s: number | undefined) => Math.max(0.25, Math.min(4, s && isFinite(s) ? s : 1));
  const scaleX = clampScale(opts.scaleX);
  const scaleY = clampScale(opts.scaleY);
  const matteChoke = Math.max(-8, Math.min(8, Math.round(opts.matteChoke && isFinite(opts.matteChoke) ? opts.matteChoke : 0)));
  const feather = Math.max(0, Math.min(8, Math.round(opts.feather && isFinite(opts.feather) ? opts.feather : 0)));
  const gOffX = isFinite(Number(opts.trackOffsetX)) ? Number(opts.trackOffsetX) : 0;
  const gOffY = isFinite(Number(opts.trackOffsetY)) ? Number(opts.trackOffsetY) : 0;
  const gRot = Math.max(-30, Math.min(30, isFinite(Number(opts.trackRotate)) ? Number(opts.trackRotate) : 0));
  const trackKeys = (Array.isArray(opts.trackKeys) ? opts.trackKeys : [])
    .map((kf) => ({
      t: Math.max(0, Math.min(1, Number(kf?.t) || 0)),
      dx: Number(kf?.dx) || 0,
      dy: Number(kf?.dy) || 0,
      rot: Number(kf?.rot) || 0,
    }))
    .sort((a, b) => a.t - b.t);
  const dir = await mkdtemp(path.join(os.tmpdir(), "sr_"));
  // Reclaim any disk leaked by earlier hard-killed runs before we start.
  await sweepStaleScreenReplaceTemp(dir);
  let srcPath = path.join(dir, "src.mp4");
  const contentPath = path.join(dir, opts.contentIsVideo ? "content.mp4" : "content.png");
  const cframesDir = path.join(dir, "cframes");
  const outPath = path.join(dir, "out.mp4");
  await writeFile(srcPath, opts.source);
  await writeFile(contentPath, opts.content);
  try {
    const { fps } = await ffprobeBasic(srcPath);
    // Probe exact frame dimensions from ONE decoded frame, then delete it. We do
    // NOT extract the whole clip to disk — every frame is streamed off a pipe
    // (openFrameStream) so a 50fps clip can't overflow the small serverless /tmp.
    const probePath = path.join(dir, "probe.png");
    await runFfmpeg(["-y", "-i", srcPath, "-frames:v", "1", probePath]);
    const meta0 = await sharp(probePath).metadata();
    let W = meta0.width ?? 0, H = meta0.height ?? 0;
    await unlink(probePath).catch(() => {});
    if (!W || !H) throw new Error("Could not read source frame dimensions");

    // 4K cap. Tracking + compositing are O(W*H) per frame, and the marker scan is
    // per-pixel, so a 4K source (e.g. 2160x3840 ≈ 8.3 MP — ~4x a 1080p frame)
    // blows the function's time budget and the run just hangs. Downscale the
    // SOURCE to a working resolution (longest side ≤ MAX_DIM) before any
    // processing. The content/UI is mapped onto the (small) on-screen quad
    // anyway, so visible screen quality barely changes while throughput rises
    // ~4x. The composite output is produced at this working resolution.
    const MAX_DIM = 1920;
    if (Math.max(W, H) > MAX_DIM) {
      const scaledPath = path.join(dir, "src_scaled.mp4");
      // Longest side → MAX_DIM, aspect preserved, dims forced even (encoder needs
      // even). Re-encode so downstream pipe-streaming of frames stays uniform.
      const vf = W >= H ? `scale=${MAX_DIM}:-2` : `scale=-2:${MAX_DIM}`;
      await runFfmpeg(["-y", "-i", srcPath, "-vf", vf, "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-an", scaledPath]);
      const probe2 = path.join(dir, "probe2.png");
      await runFfmpeg(["-y", "-i", scaledPath, "-frames:v", "1", probe2]);
      const m2 = await sharp(probe2).metadata();
      await unlink(probe2).catch(() => {});
      if (m2.width && m2.height) { W = m2.width; H = m2.height; srcPath = scaledPath; }
    }
    const frameSize = W * H * 3;

    let contentIsVideo = opts.contentIsVideo;
    let contentFiles: string[] = [];
    let contentFps = fps;
    if (contentIsVideo) {
      contentFps = (await ffprobeBasic(contentPath)).fps || fps;
      await mkdir(cframesDir);
      await runFfmpeg(["-y", "-i", contentPath, "-fps_mode", "passthrough", path.join(cframesDir, "c_%05d.png")]);
      contentFiles = (await readdir(cframesDir)).filter((f) => f.endsWith(".png")).sort();
      if (contentFiles.length === 0) contentIsVideo = false;
    }

    // Pass 1 — robust per-frame corners from the largest green component.
    // If the detected quad doesn't fit its blob well (concave / too small a
    // fill ratio), fall back to the component's axis-aligned bbox for that
    // frame, so we never produce a catastrophic warp (worst case = box fill).
    // We also keep the component's bbox: pass 2 keys green over the WHOLE green
    // extent (not just the corner quad), so rounded corners / notch don't leave
    // an un-keyed green rim.
    const MIN_SIZE = 0.0008 * W * H;
    const boxes: ([number, number, number, number] | null)[] = [];
    const cents: ([Pt, Pt, Pt, Pt] | null)[] = [];
    const allBlobs: Pt[][] = [];
    const greenQuads: GQuad[] = [];
    const sizes: number[] = []; // green-component pixel count per frame (occlusion signal)
    const insetH: number[] = [], insetV: number[] = [];
    const reader1 = openFrameStream(srcPath, frameSize);
    let nFrames = 0;
    for (;;) {
      const data = await reader1.next();
      if (data === null) break;
      if (++nFrames > 1500) { reader1.destroy(); throw new Error("Clip is too long for screen-replace tracking — trim it shorter."); }
      const comp = greenComponent(data, W, H, 3);
      if (!comp || comp.size < MIN_SIZE) { cents.push(null); boxes.push(null); greenQuads.push(null); allBlobs.push([]); sizes.push(0); continue; }
      const c = detectMarkers(data, W, H, 3, comp.bbox);
      cents.push(c);
      sizes.push(comp.size);
      if (c) sampleMarkerInset(data, W, 3, comp.bbox, c, insetH, insetV);
      // All dark-green marker blobs (corners + interior dot grid) for the
      // over-determined homography fit; empty/4 on the old 4-marker template.
      allBlobs.push(detectDarkGreenBlobs(data, W, 3, comp.bbox));
      boxes.push(comp.bbox);
      // Green-edge quad as the per-frame fallback when markers aren't clean.
      let gq: [Pt, Pt, Pt, Pt] = comp.quad;
      if (quadArea(comp.quad) < 0.55 * comp.size) {
        const [a, b, c2, d] = comp.bbox;
        gq = [[a, b], [c2, b], [c2, d], [a, d]];
      }
      greenQuads.push(gq);
    }
    reader1.destroy();
    if (nFrames === 0) throw new Error("No frames extracted from the source video");
    // AUTO-CALIBRATE the marker inset from this clip's own frames (tilt-robust
    // median). This adapts to however HeyGen fit the template into the phone
    // screen, so the SAME code tracks correctly across different source videos
    // without a hand-tuned per-clip constant. Falls back to the template's
    // design inset if too few marker frames were seen.
    let fH = insetH.length >= 8 ? median(insetH) : 0.10;
    let fV = insetV.length >= 8 ? median(insetV) : 0.14;
    // The marker inset is measured by scanning axis-aligned rows/columns of the
    // green screen. The VERTICAL scan foreshortens badly when the phone is
    // tilted — a column near the screen's left/right edge spans only a short
    // chord of the tilted screen — so it can grossly OVER-estimate fV (e.g. 0.29
    // when the real template inset is ~0.14). That stretches the tracked quad
    // ~2x vertically and zooms the inserted UI (only the centre of the content
    // lands inside the screen). Reject an implausible inset and fall back to the
    // template's nominal value so the quad matches the actual screen extent.
    if (!(fH >= 0.04 && fH <= 0.20)) fH = 0.10;
    if (!(fV >= 0.04 && fV <= 0.20)) fV = 0.14;
    const calibTMPL: Pt[] = [[fH, fV], [1 - fH, fV], [1 - fH, 1 - fV], [fH, 1 - fV]];
    let prevH: number[] | null = null; // temporal homography seed for the grid fit
    let prevQuad: GQuad = null; // previous frame quad — fresh seed for the grid fit
    const gridOk: boolean[] = []; // did the precise grid fit succeed for this frame?
    // Expected FULL-screen size, from the clean frames. On clean frames the
    // green fills the whole screen, so the component box spans the real screen;
    // its median over high-area frames is a stable reference that does NOT
    // shrink when a finger later splits the green. Used to reject a collapsed
    // fit (a quad far smaller than this) even when the collapse builds up
    // gradually frame to frame.
    const _detS = sizes.filter((s) => s > 0).sort((a, b) => a - b);
    const _baseS = _detS.length ? _detS[Math.floor(_detS.length * 0.7)] : 0;
    const _eh: number[] = [], _ew: number[] = [];
    for (let i = 0; i < sizes.length; i++) { const bb = boxes[i]; if (bb && _baseS > 0 && sizes[i] > 0.6 * _baseS) { _eh.push(bb[3] - bb[1]); _ew.push(bb[2] - bb[0]); } }
    const expH = _eh.length ? median(_eh) : 0;
    const expW = _ew.length ? median(_ew) : 0;
    // ── Self-calibrating interior template ────────────────────────────────
    // The built-in INTERIOR_TMPL only matches the original sparse marker sheet.
    // A denser or differently-laid-out marker pattern, matched against it, snaps
    // template points onto the WRONG markers and the homography fit goes wild
    // (diagonal smearing on busy frames). Instead LEARN this clip's marker layout
    // from its cleanest full-green frame: map every detected marker into
    // normalized screen coords via the inverse 4-corner homography, drop the
    // corners, and use the rest as the interior template for every frame.
    // Pattern-agnostic; falls back to INTERIOR_TMPL when no clean frame exists.
    let interiorTmpl: Pt[] = INTERIOR_TMPL;
    {
      let calI = -1, calBlobs = -1;
      for (let i = 0; i < cents.length; i++) {
        if (!cents[i] || !boxes[i]) continue;
        if (_baseS > 0 && sizes[i] < 0.9 * _baseS) continue; // full (unoccluded) green only
        const nb = allBlobs[i].length;
        if (nb > calBlobs) { calBlobs = nb; calI = i; }
      }
      if (calI >= 0 && calBlobs >= 8) {
        const Hpx2n = solveHomography(cents[calI]!, calibTMPL); // px -> normalized
        const toN = (p: Pt): Pt => {
          const w = Hpx2n[6] * p[0] + Hpx2n[7] * p[1] + Hpx2n[8];
          return [(Hpx2n[0] * p[0] + Hpx2n[1] * p[1] + Hpx2n[2]) / w, (Hpx2n[3] * p[0] + Hpx2n[4] * p[1] + Hpx2n[5]) / w];
        };
        const derived: Pt[] = [];
        for (const b of allBlobs[calI]) {
          const n = toN(b);
          if (!isFinite(n[0]) || !isFinite(n[1])) continue;
          if (n[0] < 0.05 || n[0] > 0.95 || n[1] < 0.03 || n[1] > 0.97) continue; // inside the screen
          if (calibTMPL.some((c) => Math.hypot(c[0] - n[0], c[1] - n[1]) < 0.06)) continue; // skip the 4 corners
          derived.push(n);
        }
        // Use it only if it's a well-formed, sufficiently dense, spread-out set.
        if (derived.length >= 6) {
          let nx0 = Infinity, ny0 = Infinity, nx1 = -Infinity, ny1 = -Infinity;
          for (const [x, y] of derived) { if (x < nx0) nx0 = x; if (x > nx1) nx1 = x; if (y < ny0) ny0 = y; if (y > ny1) ny1 = y; }
          if (nx1 - nx0 > 0.3 && ny1 - ny0 > 0.3) interiorTmpl = derived;
        }
      }
    }
    // Build per-frame quads: calibrated marker extrapolation (stable, blur-proof,
    // matches the screen extent), else the green-edge quad.
    const raw: GQuad[] = [];
    for (let i = 0; i < cents.length; i++) {
      if (cents[i]) {
        // Prefer the over-determined fit from the full dot grid; fall back to
        // the 4-corner fit, then to the green-edge quad.
        // Try the grid fit seeded from the detected corners first (precise on
        // clean frames). If it fails — e.g. a finger covered a corner, so the
        // corner-seeded prediction is wrong — retry seeded from the PREVIOUS
        // frame's quad (always fresh, independent of the possibly-false current
        // corners). The seed predicts where every dot should be, the visible
        // markers refine the homography, the covered corner finds no blob and is
        // dropped, and ALL four corners are then reconstructed FROM THE PLANE —
        // so a covered corner moves rigidly with the rest instead of flying off.
        let gr = screenFromGrid(cents[i]!, allBlobs[i], calibTMPL, boxes[i]!, null, interiorTmpl);
        if (!gr) {
          const seed = prevQuad ? solveHomography(TMPL_CORNERS, prevQuad) : prevH;
          if (seed) gr = screenFromGrid(cents[i]!, allBlobs[i], calibTMPL, boxes[i]!, seed, interiorTmpl);
        }
        // Reject a COLLAPSED fit. When the visible markers are clustered (a hand
        // covers part of the screen, and the finger even SPLITS the green into
        // pieces) the homography is poorly constrained and its extrapolation to
        // the uncovered corners can collapse — a quad far smaller than the real
        // screen. The previous accepted quad is a reliable reference for the
        // screen size (it barely changes frame to frame); if the new quad is far
        // smaller, the fit collapsed: drop it and fall through to the rigid
        // dot-follow, which preserves the last good FULL-screen shape and slides
        // every corner together so none flies off when its marker is covered.
        if (gr && expH > 0) {
          let qx0 = Infinity, qy0 = Infinity, qx1 = -Infinity, qy1 = -Infinity;
          for (let c = 0; c < 4; c++) { const p = gr.quad[c]; if (p[0] < qx0) qx0 = p[0]; if (p[1] < qy0) qy0 = p[1]; if (p[0] > qx1) qx1 = p[0]; if (p[1] > qy1) qy1 = p[1]; }
          if ((qy1 - qy0) < 0.7 * expH || (qx1 - qx0) < 0.7 * expW) gr = null;
        }
        if (gr) { raw.push(gr.quad); prevH = gr.H; prevQuad = gr.quad; gridOk.push(true); }
        else { const s = screenFromMarkers(cents[i]!, calibTMPL, boxes[i]!); const q = s ?? greenQuads[i]; raw.push(q); if (q) prevQuad = q; gridOk.push(false); }
      } else {
        raw.push(greenQuads[i]); gridOk.push(false);
      }
    }
    // Hold last-known corners + bbox across frames where the screen is hidden.
    let last: GQuad = null;
    let lastBox: [number, number, number, number] | null = null;
    for (let i = 0; i < raw.length; i++) {
      if (raw[i]) { last = raw[i]; lastBox = boxes[i]; }
      else { raw[i] = last; boxes[i] = lastBox; }
    }
    const firstQ = raw.find((q) => q) ?? null;
    const firstBox = boxes.find((b) => b) ?? null;
    for (let i = 0; i < raw.length && !raw[i]; i++) { raw[i] = firstQ; boxes[i] = firstBox; }
    if (!raw.some((q) => q)) throw new Error("No green screen detected in any frame — check the green color and lighting");

    // Occlusion rejection. When a finger/hand covers part of the screen the
    // per-frame detection can collapse or jerk, even though the phone itself
    // keeps moving smoothly. Flag any frame whose quad deviates sharply from a
    // robust local (±4) median and rebuild it by linear interpolation between
    // the nearest clean frames — so the insert stays locked through taps and
    // hand-overs instead of twitching. The threshold is generous (≈13% of the
    // screen size) so genuine fast motion passes through untouched.
    {
      const Nr = raw.length;
      // Wide robust baseline (±12 frames ≈ 0.4–0.5s at 50–60fps). A ±4 window
      // was too narrow: a finger held on the screen for more than a few frames
      // corrupted its own baseline (most of the window became occluded), so the
      // bad frames stopped being flagged and the insert twitched. ±12 keeps the
      // median dominated by clean frames through ordinary taps/holds. It only
      // sets the deviation reference — fast genuine motion still passes because
      // the median tracks it.
      const WIN = 12;
      const baseMed = (i: number, c: number, d: number): number => {
        const w: number[] = [];
        for (let j = Math.max(0, i - WIN); j <= Math.min(Nr - 1, i + WIN); j++) w.push(raw[j]![c][d]);
        return median(w);
      };
      const ok: boolean[] = new Array(Nr).fill(true);
      for (let i = 0; i < Nr; i++) {
        const q = raw[i]!;
        const scale =
          (Math.hypot(q[1][0] - q[0][0], q[1][1] - q[0][1]) +
            Math.hypot(q[3][0] - q[0][0], q[3][1] - q[0][1])) / 2 || 1;
        let maxDev = 0;
        for (let c = 0; c < 4; c++) {
          const dev = Math.hypot(q[c][0] - baseMed(i, c, 0), q[c][1] - baseMed(i, c, 1));
          if (dev > maxDev) maxDev = dev;
        }
        if (maxDev > 0.13 * scale) ok[i] = false;
      }
      // Planar-only rule (the rigid-plane idea): a frame is trusted ONLY if the
      // homography grid fit succeeded — then all four corners are reconstructed
      // FROM THE PLANE and a covered corner moves rigidly with the rest. Every
      // other frame (a corner detected wrong under a finger, or heavy occlusion)
      // is rebuilt by the rigid dot-follow between the nearest planar frames, so
      // no single corner can drift off on its own. Clean frames almost all pass
      // the grid fit, so this overrides only genuinely unreliable frames.
      if (gridOk.length === Nr) {
        for (let i = 0; i < Nr; i++) { if (!gridOk[i]) ok[i] = false; }
      }
      // Also distrust TRANSITION frames where the green is significantly
      // reduced (a finger entering or leaving). On those frames the grid fit is
      // biased by the shifting / partly-covered visible markers and rotates the
      // quad a few degrees; if such a frame became the dot-follow anchor it
      // would propagate that spurious rotation through the whole occlusion and
      // then snap back on recovery (a corner that "flies out and returns").
      // Only near-full-green frames anchor the rigid hold, so the orientation
      // carried through a tap is the true pre-tap orientation.
      if (_baseS > 0) {
        for (let i = 0; i < Nr; i++) { if (sizes[i] < 0.9 * _baseS) ok[i] = false; }
      }
      // Don't reject every frame (e.g. truly erratic clip) — only patch if most
      // frames are clean.
      // Residual-translation refinement for the HEAVY (occluded / transition)
      // frames. The existing hold interpolates the corners between the clean
      // anchors and nudges them by the frame-to-frame dot translation; it tracks
      // the phone closely but still lags its small in-plane drift through a tap
      // by a few px, so the inserted UI swims slightly against the screen.
      //
      // We refine — never replace — that pose: for each patched frame we PREDICT
      // every template marker from the CURRENT held pose (whose rotation/scale
      // are already correct) and match it to the nearest detected dot. The
      // MEDIAN predicted→actual offset is the small residual translation the hold
      // missed. Only this 2-D translation is applied — rotation/scale are never
      // refit (doing that on a few partly-covered markers is what made an earlier
      // attempt twitch). The residual is gap-filled where the finger covers the
      // markers, lightly smoothed and hard-clamped, so it can only tighten the
      // hold gently, never jump.
      const projPt = (H: number[], p: Pt): Pt => {
        const w = H[6] * p[0] + H[7] * p[1] + H[8];
        return [(H[0] * p[0] + H[1] * p[1] + H[2]) / w, (H[3] * p[0] + H[4] * p[1] + H[5]) / w];
      };
      const allTmplPts: Pt[] = [calibTMPL[0], calibTMPL[1], calibTMPL[2], calibTMPL[3], ...interiorTmpl];
      // Frame-to-frame dot translation (median nearest-neighbour displacement),
      // used to carry the hold through frames where the grid fit can't track.
      const dotDX = new Array(Nr).fill(0), dotDY = new Array(Nr).fill(0);
      for (let i = 1; i < Nr; i++) {
        const cur = allBlobs[i], prev = allBlobs[i - 1];
        if (!cur || !prev || cur.length < 3 || prev.length < 3) continue;
        const dxs: number[] = [], dys: number[] = [];
        for (const c of cur) {
          let bd = Infinity, bx = 0, by = 0;
          for (const p of prev) { const dd = Math.hypot(c[0] - p[0], c[1] - p[1]); if (dd < bd) { bd = dd; bx = p[0]; by = p[1]; } }
          if (bd < 40) { dxs.push(c[0] - bx); dys.push(c[1] - by); }
        }
        if (dxs.length >= 3) { dotDX[i] = median(dxs); dotDY[i] = median(dys); }
      }
      const goodCount = ok.filter(Boolean).length;
      if (goodCount >= Nr * 0.5 && goodCount < Nr) {
        let i = 0;
        while (i < Nr) {
          if (ok[i]) { i++; continue; }
          const a = i - 1;            // last clean frame
          let b = i; while (b < Nr && !ok[b]) b++;  // next clean frame (or Nr)
          const haveA = a >= 0, haveB = b < Nr;
          const span = b - a;
          const cN = b - i;
          // Baseline hold per patched frame — IDENTICAL to the previous behaviour
          // (anchor + accumulated dot translation, blended toward the next clean
          // frame). The residual refinement below is layered on top of this, so
          // we never lose the tracking the hold already provides.
          const baseQ: Pt[][] = [];
          let accX = 0, accY = 0;
          for (let k = i; k < b; k++) {
            accX += dotDX[k]; accY += dotDY[k];
            const t = span > 0 ? (k - a) / span : 0;
            const q: Pt[] = [];
            for (let c = 0; c < 4; c++) {
              let x = haveA ? raw[a]![c][0] + accX : raw[b]![c][0];
              let y = haveA ? raw[a]![c][1] + accY : raw[b]![c][1];
              if (haveA && haveB) { x = x * (1 - t) + raw[b]![c][0] * t; y = y * (1 - t) + raw[b]![c][1] * t; }
              q.push([x, y]);
            }
            baseQ.push(q);
          }
          // Residual translation per frame from held-pose-seeded marker matching.
          // NaN = no reliable reading (markers covered) — interpolated below.
          const obsX = new Array(cN).fill(NaN), obsY = new Array(cN).fill(NaN);
          for (let k = i; k < b; k++) {
            const bq = baseQ[k - i];
            const blobs = allBlobs[k];
            if (!blobs || blobs.length < 2) continue;
            const scale = (Math.hypot(bq[1][0] - bq[0][0], bq[1][1] - bq[0][1]) +
                           Math.hypot(bq[3][0] - bq[0][0], bq[3][1] - bq[0][1])) / 2 || 1;
            const Hk = solveHomography(TMPL_CORNERS, bq as [Pt, Pt, Pt, Pt]);
            const rad = 0.06 * scale;
            const dxs: number[] = [], dys: number[] = [];
            for (const tp of allTmplPts) {
              const pp = projPt(Hk, tp);
              let bd = rad, bx = 0, by = 0, hit = false;
              for (const bl of blobs) {
                const dd = Math.hypot(bl[0] - pp[0], bl[1] - pp[1]);
                if (dd < bd) { bd = dd; bx = bl[0]; by = bl[1]; hit = true; }
              }
              if (hit) { dxs.push(bx - pp[0]); dys.push(by - pp[1]); }
            }
            if (dxs.length >= 2) { obsX[k - i] = median(dxs); obsY[k - i] = median(dys); }
          }
          // Anchor the refinement at 0 on the clean ends and fill gaps by linear
          // interpolation between the frames that DID get a reading.
          const idxK: number[] = [-1], valX: number[] = [0], valY: number[] = [0];
          for (let k = 0; k < cN; k++) if (!Number.isNaN(obsX[k])) { idxK.push(k); valX.push(obsX[k]); valY.push(obsY[k]); }
          idxK.push(cN); valX.push(0); valY.push(0);
          const lerp = (vals: number[], idx: number): number => {
            if (idx <= idxK[0]) return vals[0];
            for (let s = 1; s < idxK.length; s++) {
              if (idx <= idxK[s]) {
                const t = (idx - idxK[s - 1]) / Math.max(1, idxK[s] - idxK[s - 1]);
                return vals[s - 1] * (1 - t) + vals[s] * t;
              }
            }
            return vals[vals.length - 1];
          };
          const fillX = new Array(cN), fillY = new Array(cN);
          for (let k = 0; k < cN; k++) { fillX[k] = lerp(valX, k); fillY[k] = lerp(valY, k); }
          // Light ±6 moving-average smoothing and a hard clamp (~8% of the screen
          // width) so the refinement stays gentle and strictly bounded.
          const anchorQ = raw[haveA ? a : b]!;
          const CAP = 0.08 * (Math.hypot(anchorQ[1][0] - anchorQ[0][0], anchorQ[1][1] - anchorQ[0][1]) || 1);
          const smooth = (arr: number[], k: number): number => {
            let s = 0, c = 0;
            for (let j = Math.max(0, k - 6); j <= Math.min(cN - 1, k + 6); j++) { s += arr[j]; c++; }
            return c ? s / c : 0;
          };
          for (let k = i; k < b; k++) {
            let dx = smooth(fillX, k - i), dy = smooth(fillY, k - i);
            dx = Math.max(-CAP, Math.min(CAP, dx));
            dy = Math.max(-CAP, Math.min(CAP, dy));
            const bq = baseQ[k - i];
            for (let c = 0; c < 4; c++) raw[k]![c] = [bq[c][0] + dx, bq[c][1] + dy];
          }
          i = b;
        }
      }
    }

    // Temporal stabilization (offline, centered = zero phase lag). Detection is
    // sub-pixel now (weighted centroids), so a light LINEAR smoother suffices —
    // and linear matters: a value-gated (bilateral) filter is non-linear and at
    // ordinary hand-motion speeds it keeps switching neighbours in/out of its
    // kernel, so the output jerks ("wandering"); smoothing the homography
    // coefficients instead is numerically fragile (tiny perspective terms blow
    // up after the divide). So we smooth the 4 corners directly with: 1) a 5-tap
    // median (anti-spike, preserves ramps of any speed); 2) a Savitzky–Golay
    // quadratic fit over ±SGR frames — a local position+velocity+acceleration
    // fit, so it removes jitter while tracking real motion with little lag, and
    // it is the smoothest option through mid-speed motion (lowest corner
    // acceleration) which is exactly what cures the wandering, while staying
    // perfectly predictable (linear: no erratic jumps, no low-freq drift).
    const N = raw.length;
    const med5 = (i: number, c: number, d: number): number => {
      const w: number[] = [];
      for (let j = Math.max(0, i - 2); j <= Math.min(N - 1, i + 2); j++) w.push(raw[j]![c][d]);
      return median(w);
    };
    const pre: number[][][] = raw.map((_, i) => {
      const q: number[][] = [];
      for (let c = 0; c < 4; c++) q.push([med5(i, c, 0), med5(i, c, 1)]);
      return q;
    });
    const SGR = 3;
    const sgQuad = (c: number, d: number, i: number): number => {
      let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0, b0 = 0, b1 = 0, b2 = 0;
      for (let j = Math.max(0, i - SGR); j <= Math.min(N - 1, i + SGR); j++) {
        const t = j - i, v = pre[j][c][d], t2 = t * t;
        s0 += 1; s1 += t; s2 += t2; s3 += t2 * t; s4 += t2 * t2;
        b0 += v; b1 += t * v; b2 += t2 * v;
      }
      const det = s0 * (s2 * s4 - s3 * s3) - s1 * (s1 * s4 - s3 * s2) + s2 * (s1 * s3 - s2 * s2);
      if (Math.abs(det) < 1e-9) return b0 / Math.max(1, s0);
      return (b0 * (s2 * s4 - s3 * s3) - s1 * (b1 * s4 - s3 * b2) + s2 * (b1 * s3 - s2 * b2)) / det;
    };
    const sm: Pt[][] = [];
    for (let i = 0; i < N; i++) {
      const q: Pt[] = [];
      for (let c = 0; c < 4; c++) q.push([sgQuad(c, 0, i), sgQuad(c, 1, i)]);
      sm.push(q);
    }

    // Pre-scale the content to ~the largest on-screen size across the clip. The
    // per-frame warp then samples content at roughly display resolution, so a
    // single bilinear tap is enough — instead of supersampling 4x4 from a
    // full-res (e.g. 1170x2532) image every frame, which was the dominant cost
    // (50fps clips ran ~25 min and blew the 10-min function limit). sharp's
    // high-quality downscale does the heavy lifting once, up front, and is
    // actually sharper than the JS box-average it replaces.
    let maxScreen = 1;
    for (const q of sm) {
      const sw = Math.hypot(q[1][0] - q[0][0], q[1][1] - q[0][1]);
      const sh = Math.hypot(q[3][0] - q[0][0], q[3][1] - q[0][1]);
      if (sw > maxScreen) maxScreen = sw;
      if (sh > maxScreen) maxScreen = sh;
    }
    const contentCap = Math.max(64, Math.ceil(maxScreen));

    // Cache the content image (when it's a still) so we read+decode it once,
    // pre-scaled to the on-screen size.
    let stillContent: { data: Buffer; w: number; h: number; ch: number } | null = null;
    if (!contentIsVideo) {
      const c = await sharp(contentPath)
        .removeAlpha()
        .resize(contentCap, contentCap, { fit: "inside", withoutEnlargement: true })
        .raw()
        .toBuffer({ resolveWithObject: true });
      stillContent = { data: c.data, w: c.info.width, h: c.info.height, ch: c.info.channels };
    }

    // Pass 2 — perspective-warp content onto the quad, alpha = actual green.
    // Source frames are pulled off a decode pipe (no frame files on disk) and
    // each composited frame is pushed straight into the encoder as raw RGB over
    // another pipe. Nothing but the source video and the output ever lives on
    // disk, so resolution/length can't overflow the small /tmp.
    const enc = spawnFfmpeg([
      "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${W}x${H}`, "-framerate", String(fps), "-i", "pipe:0",
      "-i", srcPath, "-map", "0:v", "-map", "1:a?",
      "-c:v", "libx264", "-preset", "medium", "-crf", "16", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-shortest", "-movflags", "+faststart",
      outPath,
    ]);
    const encStdin = enc.proc.stdin!;
    encStdin.on("error", () => {}); // swallow EPIPE if the encoder exits early
    // ── Manual tracking correction per frame: global offset/rotation + linearly
    // interpolated keyframes (Mocha-style). A frame whose interpolated correction
    // is zero stays exactly as the auto-track, so fixing one moment via keyframes
    // does not disturb the rest. Applied to the tracked screen quad in the loop.
    const corrX = new Float32Array(nFrames), corrY = new Float32Array(nFrames), corrR = new Float32Array(nFrames);
    for (let k = 0; k < nFrames; k++) {
      let dx = gOffX, dy = gOffY, rot = gRot;
      if (trackKeys.length) {
        const t = nFrames > 1 ? k / (nFrames - 1) : 0;
        let kdx: number, kdy: number, krot: number;
        const first = trackKeys[0], lastK = trackKeys[trackKeys.length - 1];
        if (t <= first.t) { kdx = first.dx; kdy = first.dy; krot = first.rot; }
        else if (t >= lastK.t) { kdx = lastK.dx; kdy = lastK.dy; krot = lastK.rot; }
        else {
          kdx = 0; kdy = 0; krot = 0;
          for (let j = 0; j < trackKeys.length - 1; j++) {
            const a = trackKeys[j], b = trackKeys[j + 1];
            if (t >= a.t && t <= b.t) {
              const f = (t - a.t) / ((b.t - a.t) || 1e-6);
              kdx = a.dx + (b.dx - a.dx) * f; kdy = a.dy + (b.dy - a.dy) * f; krot = a.rot + (b.rot - a.rot) * f;
              break;
            }
          }
        }
        dx += kdx; dy += kdy; rot += krot;
      }
      corrX[k] = dx; corrY[k] = dy; corrR[k] = rot;
    }
    const reader2 = openFrameStream(srcPath, frameSize);
    for (let k = 0; k < nFrames; k++) {
      const data = await reader2.next();
      if (data === null) break;
      const ch = 3;
      const out = Buffer.from(data);
      let cD: Buffer, cW: number, cH: number, cCh: number;
      if (contentIsVideo) {
        // Map the content frame by TIME, not by source-frame index. Source
        // frame k is at t = k / fps; show content frame round(t * contentFps).
        // This plays the content at its real speed (no speed-up when its fps
        // differs from the source), clamps to the last frame (so a shorter
        // content video holds on its final frame) and is naturally truncated
        // to the source length (a longer content video is simply cut). No loop.
        const cIdx = Math.min(contentFiles.length - 1, Math.round((k * contentFps) / fps));
        const c = await sharp(path.join(cframesDir, contentFiles[cIdx])).removeAlpha().resize(contentCap, contentCap, { fit: "inside", withoutEnlargement: true }).raw().toBuffer({ resolveWithObject: true });
        cD = c.data; cW = c.info.width; cH = c.info.height; cCh = c.info.channels;
      } else {
        cD = stillContent!.data; cW = stillContent!.w; cH = stillContent!.h; cCh = stillContent!.ch;
      }
      let q = sm[k];
      // Apply the manual tracking correction (offset + rotation about the quad
      // centre) for this frame, so the whole replacement region moves with it.
      {
        const cdx = corrX[k], cdy = corrY[k], crot = corrR[k];
        if (cdx !== 0 || cdy !== 0 || crot !== 0) {
          const qx = (q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4;
          const qy = (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4;
          const ca = Math.cos(crot * Math.PI / 180), sa = Math.sin(crot * Math.PI / 180);
          q = q.map(([px, py]) => {
            const rx = px - qx, ry = py - qy;
            return [qx + rx * ca - ry * sa + cdx, qy + rx * sa + ry * ca + cdy] as Pt;
          });
        }
      }
      // Default "fill": corner-pin the whole content onto the screen quad. The
      // homography handles the phone's tilt, so content authored at the phone's
      // aspect (UI screenshots) lands fully visible and undistorted — no crop.
      // "cover" keeps the content's aspect by center-cropping it to a phone-
      // portrait aspect first — useful for non-phone-shaped content (e.g. a
      // landscape video). It deliberately does NOT use the 2D quad's aspect,
      // which is foreshortened by the tilt and would over-crop.
      let dst: Pt[] = [[0, 0], [cW - 1, 0], [cW - 1, cH - 1], [0, cH - 1]];
      if (fit === "cover") {
        const PHONE_ASPECT = 0.462; // ~19.5:9 modern phone portrait
        const contentAspect = cW / cH;
        let cw2 = cW, ch2 = cH;
        if (contentAspect > PHONE_ASPECT) cw2 = cH * PHONE_ASPECT; // too wide → crop sides
        else ch2 = cW / PHONE_ASPECT; // too tall → crop top/bottom
        const ox = (cW - cw2) / 2, oy = (cH - ch2) / 2;
        dst = [[ox, oy], [ox + cw2 - 1, oy], [ox + cw2 - 1, oy + ch2 - 1], [ox, oy + ch2 - 1]];
      }
      // Per-axis on-screen scale: shrink/grow the CONTENT region the screen quad
      // maps to, around its centre. scale>1 → screen samples a smaller central
      // slice → content looks bigger (zoom in, edges cropped). scale<1 → screen
      // samples beyond the content → content looks smaller (edges clamp/smear).
      // Single knob to fine-tune fit without touching the warp loop below.
      if (scaleX !== 1 || scaleY !== 1) {
        const dcx = (dst[0][0] + dst[2][0]) / 2, dcy = (dst[0][1] + dst[2][1]) / 2;
        const hw = (dst[2][0] - dst[0][0]) / 2 / scaleX, hh = (dst[2][1] - dst[0][1]) / 2 / scaleY;
        dst = [[dcx - hw, dcy - hh], [dcx + hw, dcy - hh], [dcx + hw, dcy + hh], [dcx - hw, dcy + hh]];
      }
      const Hm = solveHomography(q, dst);
      // Anti-aliased downscale: the content (full UI res) is squeezed into a
      // small on-screen quad, so one bilinear sample per output pixel under-
      // samples and fine text aliases/softens. Supersample by the downscale
      // ratio (area-average ss*ss sub-samples) so text stays crisp.
      const screenW = Math.hypot(q[1][0] - q[0][0], q[1][1] - q[0][1]);
      const screenH = Math.hypot(q[3][0] - q[0][0], q[3][1] - q[0][1]);
      const ratio = Math.max(cW / Math.max(1, screenW), cH / Math.max(1, screenH));
      // Content is pre-scaled to ~display size, so 1 tap (and at most 2x2 for
      // smaller-than-max frames) is plenty — no more 4x4 supersampling.
      const ss = Math.max(1, Math.min(2, Math.ceil(ratio - 0.05)));
      const inv = 1 / ss, norm = 1 / (ss * ss);
      // Key region from the STABILIZED quad's bounding box (+ generous margin),
      // NOT the live green component box. When a finger splits the green, the
      // live component collapses and its bbox shrinks — that left a big un-keyed
      // green patch on screen. The stabilized quad doesn't collapse, so the key
      // region stays on the whole screen. Expanding the box only widens where we
      // LOOK for green (non-green pixels are skipped), so a wide margin is free
      // and also catches the bezel green just outside the marker quad.
      let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
      for (let c = 0; c < 4; c++) {
        if (q[c][0] < bx0) bx0 = q[c][0];
        if (q[c][1] < by0) by0 = q[c][1];
        if (q[c][0] > bx1) bx1 = q[c][0];
        if (q[c][1] > by1) by1 = q[c][1];
      }
      // UNION with the live green component box. If the tracked quad is a touch
      // small/skewed under occlusion, its bbox can stop short of the real screen
      // edge and leave a green sliver un-keyed at a corner. The green box covers
      // wherever green actually is; since the key loop only ever REPLACES green
      // pixels (non-green is skipped), widening the search box can't hurt — it
      // just guarantees no visible green is missed.
      const gb = boxes[k];
      if (gb) {
        if (gb[0] < bx0) bx0 = gb[0];
        if (gb[1] < by0) by0 = gb[1];
        if (gb[2] > bx1) bx1 = gb[2];
        if (gb[3] > by1) by1 = gb[3];
      }
      const mgx = Math.max(12, (bx1 - bx0) * 0.08), mgy = Math.max(12, (by1 - by0) * 0.08);
      const x0 = Math.max(0, Math.floor(bx0 - mgx)), y0 = Math.max(0, Math.floor(by0 - mgy));
      const x1 = Math.min(W - 1, Math.ceil(bx1 + mgx)), y1 = Math.min(H - 1, Math.ceil(by1 + mgy));
      // ── Matte: build the green mask over the bbox, optionally choke/spread it,
      // then composite content only where the (morphed) matte is set. Non-matte
      // pixels keep the original frame (out was seeded from data).
      const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
      let matte = new Uint8Array(bw * bh);
      for (let y = y0; y <= y1; y++) {
        const mr = (y - y0) * bw;
        for (let x = x0; x <= x1; x++) {
          const i = (y * W + x) * ch;
          const r = data[i], g = data[i + 1], b = data[i + 2];
          const bright = g > 80 && g > r * 1.4 && g > b * 1.4;
          const greenish = g > 45 && g > r * 1.25 && g > b * 1.25;
          if (bright || greenish) matte[mr + (x - x0)] = 1;
        }
      }
      if (matteChoke !== 0) {
        // Separable box erode/dilate by |matteChoke| px. +spread = dilate (OR),
        // -choke = erode (AND). Square structuring element (X pass then Y pass).
        const N = Math.abs(matteChoke), grow = matteChoke > 0;
        const tmp = new Uint8Array(bw * bh);
        for (let y = 0; y < bh; y++) {
          const mr = y * bw;
          for (let x = 0; x < bw; x++) {
            let acc = grow ? 0 : 1;
            const lo = Math.max(0, x - N), hi = Math.min(bw - 1, x + N);
            for (let xx = lo; xx <= hi; xx++) { const v = matte[mr + xx]; acc = grow ? (acc | v) : (acc & v); }
            tmp[mr + x] = acc;
          }
        }
        const m2 = new Uint8Array(bw * bh);
        for (let x = 0; x < bw; x++) {
          for (let y = 0; y < bh; y++) {
            let acc = grow ? 0 : 1;
            const lo = Math.max(0, y - N), hi = Math.min(bh - 1, y + N);
            for (let yy = lo; yy <= hi; yy++) { const v = tmp[yy * bw + x]; acc = grow ? (acc | v) : (acc & v); }
            m2[y * bw + x] = acc;
          }
        }
        matte = m2;
      }
      // Feather: box-blur the (binary) matte into a 0..255 alpha so the content↔
      // original boundary ramps over ~2*feather px instead of a hard 1px cut.
      // feather=0 → hard matte. Separable: horizontal row-sum, then vertical sum.
      let alpha: Uint8Array;
      if (feather > 0) {
        const F = feather, area = (2 * F + 1) * (2 * F + 1);
        const rowSum = new Uint16Array(bw * bh);
        for (let y = 0; y < bh; y++) {
          const mr = y * bw;
          for (let x = 0; x < bw; x++) {
            let s = 0; const lo = Math.max(0, x - F), hi = Math.min(bw - 1, x + F);
            for (let xx = lo; xx <= hi; xx++) s += matte[mr + xx];
            rowSum[mr + x] = s;
          }
        }
        alpha = new Uint8Array(bw * bh);
        for (let x = 0; x < bw; x++) {
          for (let y = 0; y < bh; y++) {
            let s = 0; const lo = Math.max(0, y - F), hi = Math.min(bh - 1, y + F);
            for (let yy = lo; yy <= hi; yy++) s += rowSum[yy * bw + x];
            alpha[y * bw + x] = Math.round((s / area) * 255);
          }
        }
      } else {
        alpha = new Uint8Array(bw * bh);
        for (let p = 0; p < alpha.length; p++) alpha[p] = matte[p] ? 255 : 0;
      }
      for (let y = y0; y <= y1; y++) {
        const mr = (y - y0) * bw;
        for (let x = x0; x <= x1; x++) {
          const af8 = alpha[mr + (x - x0)];
          if (af8 === 0) continue;
          const i = (y * W + x) * ch;
          let a0 = 0, a1 = 0, a2 = 0;
          for (let sy = 0; sy < ss; sy++) {
            for (let sx = 0; sx < ss; sx++) {
              const ox = x + (sx + 0.5) * inv - 0.5, oy = y + (sy + 0.5) * inv - 0.5;
              const w = Hm[6] * ox + Hm[7] * oy + Hm[8];
              let u = (Hm[0] * ox + Hm[1] * oy + Hm[2]) / w;
              let v = (Hm[3] * ox + Hm[4] * oy + Hm[5]) / w;
              u = Math.max(0, Math.min(cW - 1.001, u));
              v = Math.max(0, Math.min(cH - 1.001, v));
              const u0 = u | 0, v0 = v | 0, fu = u - u0, fv = v - v0;
              const o00 = (v0 * cW + u0) * cCh, o10 = (v0 * cW + u0 + 1) * cCh;
              const o01 = ((v0 + 1) * cW + u0) * cCh, o11 = ((v0 + 1) * cW + u0 + 1) * cCh;
              const w00 = (1 - fu) * (1 - fv), w10 = fu * (1 - fv), w01 = (1 - fu) * fv, w11 = fu * fv;
              a0 += cD[o00] * w00 + cD[o10] * w10 + cD[o01] * w01 + cD[o11] * w11;
              a1 += cD[o00 + 1] * w00 + cD[o10 + 1] * w10 + cD[o01 + 1] * w01 + cD[o11 + 1] * w11;
              a2 += cD[o00 + 2] * w00 + cD[o10 + 2] * w10 + cD[o01 + 2] * w01 + cD[o11 + 2] * w11;
            }
          }
          const cr = a0 * norm, cg = a1 * norm, cb = a2 * norm;
          if (af8 >= 255) {
            out[i] = Math.round(cr); out[i + 1] = Math.round(cg); out[i + 2] = Math.round(cb);
          } else {
            const fa = af8 / 255, fi = 1 - fa;
            out[i] = Math.round(cr * fa + data[i] * fi);
            out[i + 1] = Math.round(cg * fa + data[i + 1] * fi);
            out[i + 2] = Math.round(cb * fa + data[i + 2] * fi);
          }
        }
      }
      // Push the composited frame straight to the encoder as raw RGB — no PNG
      // round-trip (we were encoding PNG only for the encoder to decode it back).
      if (encStdin.writable) {
        if (!encStdin.write(out)) {
          await new Promise<void>((res) => encStdin.once("drain", () => res()));
        }
      }
    }
    reader2.destroy();
    encStdin.end();
    await enc.done;
    return await readFile(outPath);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// Build a per-frame mask video from a GREEN-SCREEN clip: the keyed green area
// becomes WHITE (the region to replace) and everything else BLACK. The green
// moves with the phone, so the mask tracks the screen automatically and finger
// occlusions are excluded for free (a finger isn't green). Drives Wan VACE.
export async function buildGreenScreenMask(
  input: Buffer,
  keyColorHex = "#00FF00",
  similarity = 0.3,
): Promise<Buffer> {
  const dir = os.tmpdir();
  const id = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const inPath = path.join(dir, `${id}_src.mp4`);
  const outPath = path.join(dir, `${id}_mask.mp4`);
  const hex = keyColorHex.replace(/^#/, "").padStart(6, "0").slice(0, 6);
  const sim = Math.min(0.9, Math.max(0.01, similarity || 0.3));
  await writeFile(inPath, input);
  try {
    await runFfmpeg([
      "-y", "-i", inPath,
      "-vf", `format=rgba,colorkey=0x${hex}:${sim}:0.10,alphaextract,negate`,
      "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
      outPath,
    ]);
    return await readFile(outPath);
  } finally {
    await unlink(inPath).catch(() => {});
    await unlink(outPath).catch(() => {});
  }
}

// Transcode any video buffer to browser-friendly MP4 (H.264/AAC). Used for
// .mov (QuickTime) which Chrome/Firefox won't play in <video>.
export async function convertToMp4(input: Buffer): Promise<Buffer> {
  const dir = os.tmpdir();
  const id = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const inPath = path.join(dir, `${id}_in`);
  const outPath = path.join(dir, `${id}_out.mp4`);
  await writeFile(inPath, input);
  try {
    try {
      await runFfmpeg(["-y", "-i", inPath, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart", outPath]);
    } catch {
      // no audio track
      await runFfmpeg(["-y", "-i", inPath, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an", "-movflags", "+faststart", outPath]);
    }
    return await readFile(outPath);
  } finally {
    await unlink(inPath).catch(() => {});
    await unlink(outPath).catch(() => {});
  }
}

// Pad a short video to ≥4s by cloning (freezing) the last frame for +2s.
// Tries with audio first; falls back to video-only if there's no audio track.
export async function padVideoToMinDuration(input: Buffer): Promise<Buffer> {
  const dir = os.tmpdir();
  const id = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const inPath = path.join(dir, `${id}_in.mp4`);
  const outPath = path.join(dir, `${id}_out.mp4`);
  await writeFile(inPath, input);
  try {
    try {
      await runFfmpeg([
        "-y", "-i", inPath,
        "-vf", "tpad=stop_mode=clone:stop_duration=2",
        "-af", "apad", "-shortest",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
        "-movflags", "+faststart",
        outPath,
      ]);
    } catch {
      // No audio track (or audio filter failed) — pad video only.
      await runFfmpeg([
        "-y", "-i", inPath,
        "-vf", "tpad=stop_mode=clone:stop_duration=2",
        "-an",
        "-c:v", "libx264", "-pix_fmt", "yuv420p",
        "-movflags", "+faststart",
        outPath,
      ]);
    }
    return await readFile(outPath);
  } finally {
    await unlink(inPath).catch(() => {});
    await unlink(outPath).catch(() => {});
  }
}

function isTooShort(msg: string): boolean {
  return /too_short|at least 4 second|duration is \d/i.test(msg);
}

// Embed a video; if it's rejected as too short, pad it and retry once.
// `paddedStoragePath` is where the padded copy is stored (e.g.
// `brands/<id>/padded/<assetId>.mp4`). Returns the embed task id.
export async function embedVideoSmart(
  url: string,
  paddedStoragePath: string,
): Promise<{ taskId: string; padded: boolean }> {
  try {
    const { taskId } = await embedVideo(url);
    return { taskId, padded: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!isTooShort(msg)) throw err;
    // Download original, pad to ≥4s, re-upload, embed the padded copy.
    const res = await fetch(url);
    if (!res.ok) throw new Error(`fetch video ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const padded = await padVideoToMinDuration(buf);
    const { cdnUrl } = await uploadBytes(padded, paddedStoragePath, "video/mp4");
    const { taskId } = await embedVideo(cdnUrl);
    return { taskId, padded: true };
  }
}
