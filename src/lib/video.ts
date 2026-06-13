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

type GBBox = { x: number; y: number; w: number; h: number } | null;

// Per-frame chroma-key composite WITH tracking. The green screen is detected in
// every frame, so the inserted content (image OR video) follows the screen's
// position and size as the phone moves; the actual per-frame green pixels are
// used as the alpha, so fingers / phone body (non-green) stay on top. This
// tracks translation + scale (good for steady, frontal and slight-angle shots);
// strong perspective rotation is not corrected (that needs planar tracking).
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
  const masksDir = path.join(dir, "masks");
  const outDir = path.join(dir, "out");
  const outPath = path.join(dir, "out.mp4");
  await mkdir(framesDir);
  await mkdir(masksDir);
  await mkdir(outDir);
  await writeFile(srcPath, opts.source);
  await writeFile(contentPath, opts.content);
  try {
    const { fps } = await ffprobeBasic(srcPath);
    // Extract source frames as JPEG (small) so /tmp stays well under serverless limits.
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

    // Pass 1 — per-frame green bbox; the binary mask is written to disk
    // (not kept in RAM) so memory stays flat regardless of clip length.
    const bboxes: GBBox[] = [];
    for (const f of frameFiles) {
      const { data, info } = await sharp(path.join(framesDir, f)).raw().toBuffer({ resolveWithObject: true });
      const ch = info.channels;
      const mask = Buffer.alloc(W * H, 0);
      let minX = W, minY = H, maxX = -1, maxY = -1;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const i = (y * W + x) * ch;
          const r = data[i], g = data[i + 1], b = data[i + 2];
          if (g > 80 && g > r * 1.4 && g > b * 1.4) {
            mask[y * W + x] = 255;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
      bboxes.push(maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 });
      await sharp(mask, { raw: { width: W, height: H, channels: 1 } }).png().toFile(path.join(masksDir, f.replace(/\.jpg$/, ".png")));
    }
    // Hold last-known bbox across frames where the screen is briefly not detected.
    let last: GBBox = null;
    for (let i = 0; i < bboxes.length; i++) {
      if (bboxes[i]) last = bboxes[i];
      else bboxes[i] = last;
    }
    const firstBB = bboxes.find((b) => b) ?? null;
    for (let i = 0; i < bboxes.length && !bboxes[i]; i++) bboxes[i] = firstBB;
    if (!bboxes.some((b) => b)) throw new Error("No green screen detected in any frame — check the green color and lighting");

    // Smooth the track (moving average ±2) to avoid jitter from detection noise.
    const sm: { x: number; y: number; w: number; h: number }[] = [];
    const win = 2;
    for (let i = 0; i < bboxes.length; i++) {
      let sx = 0, sy = 0, sw = 0, sh = 0, n = 0;
      for (let j = Math.max(0, i - win); j <= Math.min(bboxes.length - 1, i + win); j++) {
        const o = bboxes[j];
        if (o) { sx += o.x; sy += o.y; sw += o.w; sh += o.h; n++; }
      }
      const o = bboxes[i]!;
      sm.push(n ? { x: Math.round(sx / n), y: Math.round(sy / n), w: Math.round(sw / n), h: Math.round(sh / n) } : o);
    }

    // Pass 2 — place content at the (smoothed) bbox, alpha = actual green mask.
    const M = 6; // expand slightly so content fully covers the green (no fringe)
    for (let k = 0; k < frameFiles.length; k++) {
      const t = sm[k];
      const mask = await sharp(path.join(masksDir, frameFiles[k].replace(/\.jpg$/, ".png"))).greyscale().raw().toBuffer();
      const rx = Math.max(0, t.x - M), ry = Math.max(0, t.y - M);
      const rw = Math.min(W - rx, t.w + 2 * M), rh = Math.min(H - ry, t.h + 2 * M);
      const cPath = contentIsVideo ? path.join(cframesDir, contentFiles[k % contentFiles.length]) : contentPath;
      const cont = await sharp(cPath).resize(rw, rh, { fit: "fill" }).removeAlpha().raw().toBuffer();
      const canvas = Buffer.alloc(W * H * 4, 0);
      for (let y = 0; y < rh; y++) {
        for (let x = 0; x < rw; x++) {
          const dx = rx + x, dy = ry + y;
          if (mask[dy * W + dx] > 0) {
            const si = (y * rw + x) * 3, di = (dy * W + dx) * 4;
            canvas[di] = cont[si]; canvas[di + 1] = cont[si + 1]; canvas[di + 2] = cont[si + 2]; canvas[di + 3] = 255;
          }
        }
      }
      const overlay = await sharp(canvas, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
      await sharp(path.join(framesDir, frameFiles[k])).composite([{ input: overlay }]).jpeg({ quality: 95 }).toFile(path.join(outDir, frameFiles[k]));
    }

    // Re-encode composited frames with the original audio.
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
