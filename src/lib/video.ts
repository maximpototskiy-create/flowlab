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

// Find the 4 corners of the green quad from a frame: the extreme points of
// (x+y) and (x-y) are the TL/BR and TR/BL of a convex quad (the tilted screen).
// Sub-pixel accurate in practice and robust to slight rotation/perspective.
function detectGreenQuad(data: Buffer, W: number, H: number, ch: number): GQuad {
  let tl: Pt | undefined, tr: Pt | undefined, br: Pt | undefined, bl: Pt | undefined;
  let smin = Infinity, smax = -Infinity, dmin = Infinity, dmax = -Infinity, any = false;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * ch;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      if (g > 80 && g > r * 1.4 && g > b * 1.4) {
        any = true;
        const su = x + y, df = x - y;
        if (su < smin) { smin = su; tl = [x, y]; }
        if (su > smax) { smax = su; br = [x, y]; }
        if (df > dmax) { dmax = df; tr = [x, y]; }
        if (df < dmin) { dmin = df; bl = [x, y]; }
      }
    }
  }
  return any ? [tl!, tr!, br!, bl!] : null;
}

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

    // Pass 1 — detect the green quad's 4 corners in every frame.
    const quads: GQuad[] = [];
    for (const f of frameFiles) {
      const { data, info } = await sharp(path.join(framesDir, f)).raw().toBuffer({ resolveWithObject: true });
      quads.push(detectGreenQuad(data, W, H, info.channels));
    }
    // Hold last-known corners across frames where the screen is briefly hidden.
    let last: GQuad = null;
    for (let i = 0; i < quads.length; i++) {
      if (quads[i]) last = quads[i];
      else quads[i] = last;
    }
    const firstQ = quads.find((q) => q) ?? null;
    for (let i = 0; i < quads.length && !quads[i]; i++) quads[i] = firstQ;
    if (!quads.some((q) => q)) throw new Error("No green screen detected in any frame — check the green color and lighting");

    // Light corner smoothing (±1 frame) — kills detection jitter with minimal lag.
    const sm: Pt[][] = quads.map((_, i) => {
      const acc: Pt[] = [[0, 0], [0, 0], [0, 0], [0, 0]];
      let n = 0;
      for (let j = Math.max(0, i - 1); j <= Math.min(quads.length - 1, i + 1); j++) {
        const q = quads[j];
        if (q) { for (let c = 0; c < 4; c++) { acc[c][0] += q[c][0]; acc[c][1] += q[c][1]; } n++; }
      }
      return acc.map((pp) => [pp[0] / n, pp[1] / n] as Pt);
    });

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
      const xs = q.map((pp) => pp[0]), ys = q.map((pp) => pp[1]);
      const x0 = Math.max(0, Math.floor(Math.min(...xs))), x1 = Math.min(W - 1, Math.ceil(Math.max(...xs)));
      const y0 = Math.max(0, Math.floor(Math.min(...ys))), y1 = Math.min(H - 1, Math.ceil(Math.max(...ys)));
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const i = (y * W + x) * ch;
          const r = data[i], g = data[i + 1], b = data[i + 2];
          if (!(g > 80 && g > r * 1.4 && g > b * 1.4)) continue; // only inside the green (fingers stay)
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
