// ─────────────────────────────────────────────────────────────────────────
// Short-video workaround. Marengo requires video ≥ 4s. Many hooks are shorter,
// so when an embed fails with "video_duration_too_short" we pad the clip to
// ≥4s by freezing the last frame (ffmpeg tpad), re-upload the padded copy, and
// embed that. The brand asset keeps pointing at the ORIGINAL file for preview;
// only the embedding is computed from the padded version.
// ─────────────────────────────────────────────────────────────────────────
import { spawn } from "child_process";
import { writeFile, readFile, unlink } from "fs/promises";
import { existsSync } from "fs";
import os from "os";
import path from "path";
import ffmpegPath from "ffmpeg-static";
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
      "-vf", `chromakey=0x${hex}:${sim}:0.0,alphaextract,negate`,
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
