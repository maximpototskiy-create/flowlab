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

export type TextStyle = {
  size?: number;                       // multiplier of base font (W/16), default 1
  color?: string;                      // text color, default #fff
  weight?: number;                     // 400..900, default 800
  font?: string;                       // css font-family, default sans-serif
  stroke?: string;                     // stroke color ("" = none)
  strokeW?: number;                    // stroke width as fraction of font size (e.g. 0.08)
  shadow?: boolean;                    // soft drop shadow, default true
  shadowColor?: string;                // shadow color (default near-black)
  noPunct?: boolean;                   // strip punctuation from rendered captions
  plate?: "none" | "full" | "word";    // background plate: none / full line / active word
  plateColor?: string;                 // plate color
  radius?: number;                     // plate corner radius as fraction of font size (default 0.22)
  highlight?: string;                  // active-word text color (karaoke)
  pos?: "bottom" | "center" | "top";
  enter?: "" | "scale" | "bounce" | "fade" | "typewriter";
  upper?: boolean;                     // uppercase
};
export type CapWord = { text: string; t: number; d: number }; // relative to clip start (s)

export type ExportClip = {
  id: string;
  layer: string;
  kind: "video" | "image" | "audio" | "text" | "fx" | "adjust";
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
  inset?: number; // media in-point (s)
  tstyle?: TextStyle;
  words?: CapWord[];
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

function drawFx(ctx: CanvasRenderingContext2D, fx: string | undefined, W: number, H: number) {
  switch (fx) {
    case "flash": ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, W, H); break;
    case "tint": ctx.fillStyle = "rgba(255,120,40,0.25)"; ctx.fillRect(0, 0, W, H); break;
    case "coolTint": ctx.fillStyle = "rgba(40,120,255,0.22)"; ctx.fillRect(0, 0, W, H); break;
    case "fadeBlack": ctx.fillStyle = "#000"; ctx.fillRect(0, 0, W, H); break;
    case "blackbars": { const bar = H * 0.12; ctx.fillStyle = "#000"; ctx.fillRect(0, 0, W, bar); ctx.fillRect(0, H - bar, W, bar); break; }
    default: { // vignette
      const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.max(W, H) * 0.72);
      g.addColorStop(0, "rgba(0,0,0,0)"); g.addColorStop(1, "rgba(0,0,0,0.78)");
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    }
  }
}

function easeOutCubic(p: number) { return 1 - Math.pow(1 - p, 3); }
function easeOutBack(p: number) { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2); }

// Draw a styled caption (plate / word-highlight / karaoke / stroke / shadow / enter animations).
export function drawCaption(ctx: CanvasRenderingContext2D, c: ExportClip, tt: number, W: number, H: number, sx: number, v: { opacity: number; scaleMul: number; offX: number; offY: number }): { x: number; y: number; w: number; h: number } | null {
  const st = c.tstyle || {};
  let text = c.text || ""; if (st.upper) text = text.toUpperCase();
  if (st.noPunct) text = text.replace(/[.,!?;:…"'„“”«»]/g, "");
  if (!text.trim()) return null;
  const local = tt - c.start;
  const fontPx = Math.max(14, W / 16) * (st.size ?? 1) * (c.scale || 1) * v.scaleMul;
  const family = st.font || "sans-serif";
  const weight = st.weight ?? 800;
  ctx.font = `${weight} ${Math.round(fontPx)}px ${family}`;
  ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";

  // entrance
  let alpha = 1, scl = 1, typeChars = Infinity;
  const ep = Math.min(1, local / 0.28);
  if (st.enter === "fade") alpha = ep;
  else if (st.enter === "scale") scl = 0.6 + 0.4 * easeOutCubic(ep);
  else if (st.enter === "bounce") scl = Math.max(0.01, easeOutBack(ep));
  else if (st.enter === "typewriter") { const td = Math.min(0.9, c.duration * 0.6); typeChars = Math.max(1, Math.floor((Math.min(1, local / td)) * text.length)); }

  // words (for word plate / karaoke); fall back to splitting evenly
  const rawWords = text.split(/\s+/).filter(Boolean);
  const wordsMeta: CapWord[] = (c.words && c.words.length === rawWords.length)
    ? c.words
    : rawWords.map((w, i) => ({ text: w, t: (c.duration / rawWords.length) * i, d: c.duration / rawWords.length }));
  const activeIdx = wordsMeta.findIndex((w) => local >= w.t && local < w.t + w.d);

  // typewriter cut
  let shown = text; if (typeChars !== Infinity) shown = text.slice(0, typeChars);
  const shownWords = shown.split(/\s+/).filter(Boolean);

  // wrap into lines (greedy, ~86% width)
  const maxW = W * 0.86; const space = ctx.measureText(" ").width;
  type WLine = { words: { w: string; idx: number; width: number }[]; width: number };
  const lines: WLine[] = [{ words: [], width: 0 }];
  shownWords.forEach((w, idx) => {
    const ww = ctx.measureText(w).width;
    const ln = lines[lines.length - 1];
    const add = ln.words.length ? space + ww : ww;
    if (ln.width + add > maxW && ln.words.length) lines.push({ words: [{ w, idx, width: ww }], width: ww });
    else { ln.words.push({ w, idx, width: ww }); ln.width += add; }
  });

  const lineH = fontPx * 1.22;
  const ascent = fontPx * 0.8, descent = fontPx * 0.2;
  const n = lines.length;
  const cx = W / 2 + (c.x || 0) * sx + v.offX * W;
  const pos = st.pos || "bottom";
  // last-line baseline so the text block matches the preview anchor
  let lastBaseline: number;
  if (pos === "top") lastBaseline = H * 0.10 + ascent + (n - 1) * lineH;
  else if (pos === "center") lastBaseline = H * 0.5 + (n * lineH) / 2 - descent;
  else lastBaseline = H * 0.85 - descent;
  const cy = lastBaseline + (c.y || 0) * sx + v.offY * H;

  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, alpha * v.opacity));
  const blockH = n * lineH;
  ctx.translate(cx, cy - blockH / 2); ctx.scale(scl, scl); ctx.translate(-cx, -(cy - blockH / 2));

  const padX = fontPx * 0.28, padY = fontPx * 0.16, rad = fontPx * (st.radius ?? 0.22);
  const rrect = (x: number, y: number, w: number, h: number, r: number) => { const rr = Math.min(r, h / 2, w / 2); ctx.beginPath(); ctx.moveTo(x + rr, y); ctx.arcTo(x + w, y, x + w, y + h, rr); ctx.arcTo(x + w, y + h, x, y + h, rr); ctx.arcTo(x, y + h, x, y, rr); ctx.arcTo(x, y, x + w, y, rr); ctx.closePath(); };
  // plate sized to the REAL glyph box (actualBoundingBox), so it's vertically centered on the text
  const boxFor = (txt: string, yb: number, p: number) => {
    const m = ctx.measureText(txt);
    const a = m.actualBoundingBoxAscent && isFinite(m.actualBoundingBoxAscent) ? m.actualBoundingBoxAscent : ascent;
    const d = m.actualBoundingBoxDescent && isFinite(m.actualBoundingBoxDescent) ? m.actualBoundingBoxDescent : descent;
    return { top: yb - a - p, h: a + d + p * 2 };
  };

  lines.forEach((ln, li) => {
    const lw = ln.words.reduce((s, w, i) => s + w.width + (i ? space : 0), 0);
    let x = cx - lw / 2;
    const yBottom = cy - (lines.length - 1 - li) * lineH;
    if (st.plate === "full") {
      ctx.save(); ctx.shadowColor = "transparent";
      ctx.fillStyle = st.plateColor || "rgba(0,0,0,0.75)";
      const b = boxFor(ln.words.map((w) => w.w).join(" "), yBottom, padY);
      rrect(x - padX, b.top, lw + padX * 2, b.h, rad); ctx.fill(); ctx.restore();
    }
    for (const wo of ln.words) {
      const isActive = wo.idx === activeIdx;
      if (st.plate === "word" && isActive) {
        ctx.save(); ctx.shadowColor = "transparent";
        ctx.fillStyle = st.plateColor || "#FFD60A";
        const b = boxFor(wo.w, yBottom, padY * 0.85);
        rrect(x - padX * 0.5, b.top, wo.width + padX, b.h, rad); ctx.fill(); ctx.restore();
      }
      if (st.shadow !== false) { ctx.shadowColor = st.shadowColor || "rgba(0,0,0,0.85)"; ctx.shadowBlur = fontPx * 0.18; ctx.shadowOffsetY = fontPx * 0.05; } else ctx.shadowColor = "transparent";
      const swFrac = st.strokeW ?? 0.08;
      if (st.stroke && swFrac > 0) { ctx.lineJoin = "round"; ctx.lineWidth = fontPx * swFrac; ctx.strokeStyle = st.stroke; ctx.strokeText(wo.w, x, yBottom); }
      ctx.fillStyle = isActive && st.highlight ? st.highlight : (st.plate === "word" && isActive ? "#111" : (st.color || "#fff"));
      ctx.fillText(wo.w, x, yBottom);
      x += wo.width + space;
    }
  });
  ctx.restore();
  // block bounding box (unscaled), used by the editor for hit-testing
  const maxLineW = Math.max(...lines.map((ln) => ln.words.reduce((s, w, i) => s + w.width + (i ? space : 0), 0)), 0);
  const top = cy - (n - 1) * lineH - ascent - padY;
  return { x: cx - maxLineW / 2 - padX, y: top, w: maxLineW + padX * 2, h: (cy + descent + padY) - top };
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
  const tcanvas = document.createElement("canvas");
  tcanvas.width = W; tcanvas.height = H;
  const tctx = tcanvas.getContext("2d");
  if (!tctx) throw new Error("no 2d context");

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
          const loc = tt - c.start + (c.inset || 0);
          if (Math.abs(el.currentTime - loc) > 0.35) { try { el.currentTime = loc; } catch { /* */ } }
          try { (el as HTMLMediaElement).volume = alphaAt(c, tt); } catch { /* */ }
          if (el.paused) el.play().catch(() => {});
        } else {
          if (!el.paused) el.pause();
          const ahead = c.start - tt;
          if (ahead > 0 && ahead < 2) {
            const want = c.inset || 0;
            if (Math.abs(el.currentTime - want) > 0.05) { try { el.currentTime = want; } catch { /* */ } }
          }
        }
      }

      // draw frame — single bottom→top pass (clips arrive z-ordered)
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, W, H);
      for (const c of clips) {
        if (c.kind === "audio") continue;
        if (!(tt >= c.start && tt < c.start + c.duration)) continue;

        if (c.kind === "adjust") {
          if (!c.fx) continue;
          // filter only what's already drawn below this layer
          tctx.clearRect(0, 0, W, H);
          tctx.drawImage(canvas, 0, 0);
          ctx.clearRect(0, 0, W, H);
          ctx.filter = c.fx;
          ctx.drawImage(tcanvas, 0, 0);
          ctx.filter = "none";
          continue;
        }
        if (c.kind === "fx") {
          ctx.save();
          ctx.globalAlpha = alphaAt(c, tt) || 1;
          drawFx(ctx, c.fx, W, H);
          ctx.restore();
          continue;
        }

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
          drawCaption(ctx, c, tt, W, H, sx, { opacity: v.opacity, scaleMul: 1, offX: 0, offY: 0 });
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
