// src/lib/editor/exportVideo.ts
// WYSIWYG timeline export: draw the composition onto a canvas frame-by-frame
// (matching the editor preview, incl. per-clip scale/position/text) and capture
// it with MediaRecorder into MP4 (or WebM fallback) + audio via Web Audio.
// No engine, no keys, no watermark.
//
// Requires CORS on the media host (Supabase bucket): drawing cross-origin media
// onto a canvas taints it unless the host sends Access-Control-Allow-Origin and
// the elements are loaded with crossOrigin="anonymous". On failure we surface a
// clear error instead of silently producing a black/broken file.

import { alphaAt, clipVisual, type CompClip } from "./compositor";

export type ExportClip = {
  id: string;
  track: "video" | "audio" | "text";
  kind: "video" | "image" | "audio" | "text" | "fx";
  url?: string;
  text?: string;
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

type Params = {
  clips: ExportClip[];
  width: number;
  height: number;
  previewWidth: number; // px the x/y offsets were authored in
  onProgress?: (p: number) => void;
};

// Cache-bust so the crossOrigin fetch isn't served from a previously cached
// (non-CORS) response loaded by the preview/bin — that would taint the canvas.
function corsUrl(u: string): string {
  return u + (u.includes("?") ? "&" : "?") + "flcors=1";
}

function loadVideoEl(url: string): Promise<HTMLVideoElement> {
  return new Promise((resolve, reject) => {
    const v = document.createElement("video");
    v.crossOrigin = "anonymous";
    v.preload = "auto";
    v.playsInline = true;
    v.src = corsUrl(url);
    v.onloadeddata = () => resolve(v);
    v.onerror = () => reject(new Error("video load failed (CORS?)"));
  });
}
function loadImgEl(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const i = new Image();
    i.crossOrigin = "anonymous";
    i.src = corsUrl(url);
    i.onload = () => resolve(i);
    i.onerror = () => reject(new Error("image load failed (CORS?)"));
  });
}
function loadAudioEl(url: string): Promise<HTMLAudioElement> {
  return new Promise((resolve, reject) => {
    const a = document.createElement("audio");
    a.crossOrigin = "anonymous";
    a.preload = "auto";
    a.src = corsUrl(url);
    a.onloadeddata = () => resolve(a);
    a.onerror = () => reject(new Error("audio load failed (CORS?)"));
  });
}

function pickMime(): { type: string; mp4: boolean } {
  const candidates = [
    "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
    "video/mp4;codecs=avc1.4d002a,mp4a.40.2",
    "video/mp4",
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ];
  for (const t of candidates) {
    try { if (MediaRecorder.isTypeSupported(t)) return { type: t, mp4: t.includes("mp4") }; } catch { /* */ }
  }
  return { type: "", mp4: false };
}

export async function exportTimeline(p: Params): Promise<{ blob: Blob; ext: string; mp4: boolean }> {
  const { clips, width: W, height: H, previewWidth } = p;
  const total = Math.max(0.1, ...clips.map((c) => c.start + c.duration));
  const sx = previewWidth > 1 ? W / previewWidth : 1; // preview px -> export px

  // preload media
  const videos = new Map<string, HTMLVideoElement>();
  const images = new Map<string, HTMLImageElement>();
  const audios = new Map<string, HTMLAudioElement>();
  for (const c of clips) {
    if (!c.url) continue;
    if (c.kind === "video") videos.set(c.id, await loadVideoEl(c.url));
    else if (c.kind === "image") images.set(c.id, await loadImgEl(c.url));
    else if (c.kind === "audio") audios.set(c.id, await loadAudioEl(c.url));
  }

  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d context");

  // audio graph
  let audioStream: MediaStream | null = null;
  let audioCtx: AudioContext | null = null;
  try {
    const AC: typeof AudioContext = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    audioCtx = new AC();
    await audioCtx.resume();
    const dest = audioCtx.createMediaStreamDestination();
    let any = false;
    for (const c of clips) {
      const el = c.kind === "video" ? videos.get(c.id) : c.kind === "audio" ? audios.get(c.id) : undefined;
      if (!el) continue;
      try { const src = audioCtx.createMediaElementSource(el); src.connect(dest); any = true; } catch { /* */ }
    }
    if (any) audioStream = dest.stream;
  } catch (e) { console.warn("[export] audio routing failed", e); }

  const fps = 30;
  const vStream = canvas.captureStream(fps);
  const tracks = [...vStream.getVideoTracks(), ...(audioStream ? audioStream.getAudioTracks() : [])];
  const stream = new MediaStream(tracks);

  const { type, mp4 } = pickMime();
  const rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
  const chunks: BlobPart[] = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  const stopped = new Promise<Blob>((resolve) => { rec.onstop = () => resolve(new Blob(chunks, { type: type || "video/webm" })); });

  // reset media to 0
  for (const v of videos.values()) { try { v.currentTime = 0; } catch { /* */ } }
  for (const a of audios.values()) { try { a.currentTime = 0; } catch { /* */ } }

  rec.start(100);
  const startTs = performance.now();

  // verify the canvas isn't tainted (cross-origin) early — draw 1 frame then read
  await new Promise<void>((resolve, reject) => {
    const draw = () => {
      const tt = (performance.now() - startTs) / 1000;
      p.onProgress?.(Math.min(1, tt / total));
      if (tt >= total) { resolve(); return; }

      // drive media playback
      for (const c of clips) {
        const el = c.kind === "video" ? videos.get(c.id) : c.kind === "audio" ? audios.get(c.id) : undefined;
        if (!el) continue;
        const active = tt >= c.start && tt < c.start + c.duration;
        if (active) {
          const loc = tt - c.start;
          if (Math.abs(el.currentTime - loc) > 0.35) { try { el.currentTime = loc; } catch { /* */ } }
          try { (el as HTMLMediaElement).volume = alphaAt(c, tt); } catch { /* */ }
          if (el.paused) el.play().catch(() => {});
        } else if (!el.paused) el.pause();
      }

      // draw frame
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, W, H);
      for (const c of clips) {
        if (!(tt >= c.start && tt < c.start + c.duration)) continue;
        if (c.kind === "fx") continue;
        const v = clipVisual(c as CompClip, tt, clips as CompClip[]);
        if (v.opacity <= 0.001) continue;
        ctx.save();
        ctx.globalAlpha = v.opacity;
        if (v.reveal != null) { ctx.beginPath(); ctx.rect(0, 0, W * v.reveal, H); ctx.clip(); }
        if (c.kind === "video" || c.kind === "image") {
          const el: HTMLVideoElement | HTMLImageElement | undefined = c.kind === "video" ? videos.get(c.id) : images.get(c.id);
          if (el) {
            const mw = c.kind === "video" ? (el as HTMLVideoElement).videoWidth : (el as HTMLImageElement).naturalWidth;
            const mh = c.kind === "video" ? (el as HTMLVideoElement).videoHeight : (el as HTMLImageElement).naturalHeight;
            if (mw && mh) {
              const fit = Math.min(W / mw, H / mh) * (c.scale || 1) * v.scaleMul;
              const dw = mw * fit, dh = mh * fit;
              const dx = (W - dw) / 2 + (c.x || 0) * sx + v.offX * W;
              const dy = (H - dh) / 2 + (c.y || 0) * sx + v.offY * H;
              try { ctx.drawImage(el, dx, dy, dw, dh); } catch { /* */ }
            }
          }
        } else if (c.kind === "text") {
          const fontPx = Math.max(14, W / 16) * (c.scale || 1) * v.scaleMul;
          ctx.font = `bold ${Math.round(fontPx)}px sans-serif`;
          ctx.fillStyle = "#fff";
          ctx.textAlign = "center";
          ctx.textBaseline = "bottom";
          ctx.shadowColor = "#000";
          ctx.shadowBlur = 8;
          ctx.fillText(c.text || "", W / 2 + (c.x || 0) * sx + v.offX * W, H * 0.88 + (c.y || 0) * sx + v.offY * H);
        }
        ctx.restore();
      }
      ctx.globalAlpha = 1;

      // overlay FX on top
      for (const c of clips) {
        if (c.kind !== "fx" || !(tt >= c.start && tt < c.start + c.duration)) continue;
        ctx.save();
        ctx.globalAlpha = alphaAt(c, tt) || 1;
        if (c.fx === "flash") { ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, W, H); }
        else if (c.fx === "tint") { ctx.fillStyle = "rgba(255,120,40,0.25)"; ctx.fillRect(0, 0, W, H); }
        else { // vignette
          const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.max(W, H) * 0.72);
          g.addColorStop(0, "rgba(0,0,0,0)"); g.addColorStop(1, "rgba(0,0,0,0.75)");
          ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
        }
        ctx.restore();
      }
      ctx.globalAlpha = 1;

      // taint check on first frame
      if (tt < 0.1) {
        try { ctx.getImageData(0, 0, 1, 1); }
        catch { reject(new Error("canvas tainted (SecurityError) — нужен CORS на Supabase-бакете")); return; }
      }
      requestAnimationFrame(draw);
    };
    requestAnimationFrame(draw);
  });

  rec.stop();
  for (const v of videos.values()) { try { v.pause(); } catch { /* */ } }
  for (const a of audios.values()) { try { a.pause(); } catch { /* */ } }
  try { await audioCtx?.close(); } catch { /* */ }

  const blob = await stopped;
  return { blob, ext: mp4 ? "mp4" : "webm", mp4 };
}
