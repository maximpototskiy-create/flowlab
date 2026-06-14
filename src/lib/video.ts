// ─────────────────────────────────────────────────────────────────────────
// Short-video workaround. Marengo requires video ≥ 4s. Many hooks are shorter,
// so when an embed fails with "video_duration_too_short" we pad the clip to
// ≥4s by freezing the last frame (ffmpeg tpad), re-upload the padded copy, and
// embed that. The brand asset keeps pointing at the ORIGINAL file for preview;
// only the embedding is computed from the padded version.
// ─────────────────────────────────────────────────────────────────────────
import { spawn } from "child_process";
import { writeFile, readFile, unlink, mkdtemp, mkdir, readdir, rm } from "fs/promises";
import { existsSync } from "fs";
import os from "os";
import path from "path";
import ffmpegPath from "ffmpeg-static";
import sharp from "sharp";
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

const isGreen = (data: Buffer, i: number) => {
  const r = data[i], g = data[i + 1], b = data[i + 2];
  return g > 80 && g > r * 1.4 && g > b * 1.4;
};

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
}): Promise<Buffer> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sr_"));
  const srcPath = path.join(dir, "src.mp4");
  const contentPath = path.join(dir, opts.contentIsVideo ? "content.mp4" : "content.png");
  const framesDir = path.join(dir, "frames");
  const cframesDir = path.join(dir, "cframes");
  const outDir = path.join(dir, "out");
  const outPath = path.join(dir, "out.mp4");
  await mkdir(framesDir);
  await mkdir(outDir);
  await writeFile(srcPath, opts.source);
  await writeFile(contentPath, opts.content);
  try {
    const { fps } = await ffprobeBasic(srcPath);
    await runFfmpeg(["-y", "-i", srcPath, "-fps_mode", "passthrough", "-q:v", "3", path.join(framesDir, "f_%05d.jpg")]);
    const frameFiles = (await readdir(framesDir)).filter((f) => f.endsWith(".jpg")).sort();
    if (frameFiles.length === 0) throw new Error("No frames extracted from the source video");
    if (frameFiles.length > 1500) throw new Error("Clip is too long for composite tracking — trim it shorter or use the Wan method");

    let contentIsVideo = opts.contentIsVideo;
    let contentFiles: string[] = [];
    if (contentIsVideo) {
      await mkdir(cframesDir);
      await runFfmpeg(["-y", "-i", contentPath, "-fps_mode", "passthrough", "-q:v", "3", path.join(cframesDir, "c_%05d.jpg")]);
      contentFiles = (await readdir(cframesDir)).filter((f) => f.endsWith(".jpg")).sort();
      if (contentFiles.length === 0) contentIsVideo = false;
    }

    const meta0 = await sharp(path.join(framesDir, frameFiles[0])).metadata();
    const W = meta0.width ?? 0, H = meta0.height ?? 0;
    if (!W || !H) throw new Error("Could not read source frame dimensions");

    // Pass 1 — robust per-frame corners from the largest green component.
    // If the detected quad doesn't fit its blob well (concave / too small a
    // fill ratio), fall back to the component's axis-aligned bbox for that
    // frame, so we never produce a catastrophic warp (worst case = box fill).
    // We also keep the component's bbox: pass 2 keys green over the WHOLE green
    // extent (not just the corner quad), so rounded corners / notch don't leave
    // an un-keyed green rim.
    const MIN_SIZE = 0.0008 * W * H;
    const raw: GQuad[] = [];
    const boxes: ([number, number, number, number] | null)[] = [];
    for (const f of frameFiles) {
      const { data, info } = await sharp(path.join(framesDir, f)).raw().toBuffer({ resolveWithObject: true });
      const comp = greenComponent(data, W, H, info.channels);
      if (!comp || comp.size < MIN_SIZE) { raw.push(null); boxes.push(null); continue; }
      let chosen: [Pt, Pt, Pt, Pt] = comp.quad;
      if (quadArea(comp.quad) < 0.55 * comp.size) {
        const [a, b, c, d] = comp.bbox;
        chosen = [[a, b], [c, b], [c, d], [a, d]];
      }
      raw.push(chosen);
      boxes.push(comp.bbox);
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

    // Temporal stabilization (offline, so centered = zero lag):
    //  1) reject outlier frames (motion-blur spikes) by clamping any corner that
    //     deviates from its local median (±3) by more than 12px;
    //  2) smooth with a centered moving average (±3) to kill residual jitter.
    const N = raw.length;
    const sm: Pt[][] = raw.map((q) => q!.map((p) => [p[0], p[1]] as Pt));
    for (let c = 0; c < 4; c++) {
      for (let d = 0; d < 2; d++) {
        const v = raw.map((q) => q![c][d]);
        const clamped = v.map((val, i) => {
          const win: number[] = [];
          for (let j = Math.max(0, i - 3); j <= Math.min(N - 1, i + 3); j++) win.push(v[j]);
          const m = median(win);
          return Math.abs(val - m) > 12 ? m : val;
        });
        for (let i = 0; i < N; i++) {
          let s = 0, n = 0;
          for (let j = Math.max(0, i - 3); j <= Math.min(N - 1, i + 3); j++) { s += clamped[j]; n++; }
          sm[i][c][d] = s / n;
        }
      }
    }

    // Cache the content image (when it's a still) so we read+decode it once.
    let stillContent: { data: Buffer; w: number; h: number; ch: number } | null = null;
    if (!contentIsVideo) {
      const c = await sharp(contentPath).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      stillContent = { data: c.data, w: c.info.width, h: c.info.height, ch: c.info.channels };
    }

    // Pass 2 — perspective-warp content onto the quad, alpha = actual green.
    for (let k = 0; k < frameFiles.length; k++) {
      const { data, info } = await sharp(path.join(framesDir, frameFiles[k])).raw().toBuffer({ resolveWithObject: true });
      const ch = info.channels;
      const out = Buffer.from(data);
      let cD: Buffer, cW: number, cH: number, cCh: number;
      if (contentIsVideo) {
        const c = await sharp(path.join(cframesDir, contentFiles[k % contentFiles.length])).removeAlpha().raw().toBuffer({ resolveWithObject: true });
        cD = c.data; cW = c.info.width; cH = c.info.height; cCh = c.info.channels;
      } else {
        cD = stillContent!.data; cW = stillContent!.w; cH = stillContent!.h; cCh = stillContent!.ch;
      }
      const q = sm[k];
      const Hm = solveHomography(q, [[0, 0], [cW - 1, 0], [cW - 1, cH - 1], [0, cH - 1]]);
      // Iterate the WHOLE green extent (component bbox + margin), not just the
      // corner quad — otherwise rounded corners / the notch leave a green rim.
      const box = boxes[k]!;
      const MG = 5;
      const x0 = Math.max(0, box[0] - MG), y0 = Math.max(0, box[1] - MG);
      const x1 = Math.min(W - 1, box[2] + MG), y1 = Math.min(H - 1, box[3] + MG);
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const i = (y * W + x) * ch;
          const r = data[i], g = data[i + 1], b = data[i + 2];
          // Fill content over bright green AND the dim/anti-aliased/motion-blur
          // green edge (greenish). This leaves no green rim and no grey patches
          // on blurred frames. Skin/fingers/teal background aren't greenish.
          const bright = g > 80 && g > r * 1.4 && g > b * 1.4;
          const greenish = g > 45 && g > r * 1.25 && g > b * 1.25;
          if (!bright && !greenish) continue;
          const w = Hm[6] * x + Hm[7] * y + Hm[8];
          let u = (Hm[0] * x + Hm[1] * y + Hm[2]) / w;
          let v = (Hm[3] * x + Hm[4] * y + Hm[5]) / w;
          u = Math.max(0, Math.min(cW - 1.001, u));
          v = Math.max(0, Math.min(cH - 1.001, v));
          const u0 = u | 0, v0 = v | 0, fu = u - u0, fv = v - v0;
          const o00 = (v0 * cW + u0) * cCh, o10 = (v0 * cW + u0 + 1) * cCh;
          const o01 = ((v0 + 1) * cW + u0) * cCh, o11 = ((v0 + 1) * cW + u0 + 1) * cCh;
          for (let c = 0; c < 3; c++) {
            out[i + c] = Math.round(
              cD[o00 + c] * (1 - fu) * (1 - fv) + cD[o10 + c] * fu * (1 - fv) +
              cD[o01 + c] * (1 - fu) * fv + cD[o11 + c] * fu * fv,
            );
          }
        }
      }
      await sharp(out, { raw: { width: W, height: H, channels: ch } }).jpeg({ quality: 95 }).toFile(path.join(outDir, frameFiles[k]));
    }

    await runFfmpeg([
      "-y", "-framerate", String(fps), "-i", path.join(outDir, "f_%05d.jpg"),
      "-i", srcPath, "-map", "0:v", "-map", "1:a?",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "-movflags", "+faststart",
      outPath,
    ]);
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
