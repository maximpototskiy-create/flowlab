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
  align?: "left" | "center" | "right"; // line alignment inside the text block (default center)
  enter?: "" | "scale" | "bounce" | "fade" | "typewriter" | "slideUp" | "slideDown" | "zoomIn" | "spin" | "wipeRight" | "wipeLeft" | "blurIn" | "wordsUp";
  exit?: "" | "fade" | "scale" | "zoomOut" | "slideUp" | "slideDown" | "wipeLeft" | "wipeRight" | "blurOut";
  loop?: "" | "pulse" | "float" | "wiggle";
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
  fit?: "cover" | "contain" | "blur"; // how media adapts to the canvas aspect
  fadeIn: number;
  fadeOut: number;
  anim?: string;
  fx?: string;
  transType?: string;
  inset?: number; // media in-point (s)
  volume?: number; // 0..2, default 1
  muted?: boolean;
  blend?: string;    // "" | "screen" (drop black) | "multiply" (drop white)
  keyColor?: string; // chroma key color (hex), e.g. "#00ff00"
  keyTol?: number;   // 0..1 tolerance (default 0.3)
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

function loadVideoEl(src: string): Promise<HTMLVideoElement> {
  return new Promise((resolve, reject) => {
    const v = document.createElement("video");
    v.crossOrigin = "anonymous";
    v.preload = "auto";
    v.playsInline = true;
    v.src = src; // callers pass a prefetched blob: URL (or a corsUrl fallback)
    v.onloadeddata = () => resolve(v);
    v.onerror = () => reject(new Error("video load failed (CORS?)"));
  });
}
function loadImgEl(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const i = new Image();
    i.crossOrigin = "anonymous";
    i.src = src;
    i.onload = () => resolve(i);
    i.onerror = () => reject(new Error("image load failed (CORS?)"));
  });
}
function loadAudioEl(src: string): Promise<HTMLAudioElement> {
  return new Promise((resolve, reject) => {
    const a = document.createElement("audio");
    a.crossOrigin = "anonymous";
    a.preload = "auto";
    a.src = src;
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

function hexToRgb(hex: string): [number, number, number] {
  const m = hex.replace("#", "");
  const v = m.length === 3 ? m.split("").map((c) => c + c).join("") : m;
  const n = parseInt(v, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const keyScratch: { cv: HTMLCanvasElement | null } = { cv: null };
// draws `el` keyed (keyColor pixels → transparent) at dx/dy/dw/dh; processing capped at 720px wide
function drawKeyed(ctx: CanvasRenderingContext2D, el: CanvasImageSource, c: ExportClip, dx: number, dy: number, dw: number, dh: number) {
  const [kr, kg, kb] = hexToRgb(c.keyColor || "#00ff00");
  const tol = Math.max(0.02, Math.min(1, c.keyTol ?? 0.3)) * 255 * 1.5;
  const pw = Math.max(2, Math.min(720, Math.round(dw)));
  const ph = Math.max(2, Math.round(pw * (dh / Math.max(1, dw))));
  if (!keyScratch.cv) keyScratch.cv = document.createElement("canvas");
  const cv = keyScratch.cv;
  if (cv.width !== pw || cv.height !== ph) { cv.width = pw; cv.height = ph; }
  const kctx = cv.getContext("2d", { willReadFrequently: true });
  if (!kctx) return;
  try {
    kctx.clearRect(0, 0, pw, ph);
    kctx.drawImage(el, 0, 0, pw, ph);
    const img = kctx.getImageData(0, 0, pw, ph);
    const d = img.data;
    const soft = tol * 0.4;
    for (let i = 0; i < d.length; i += 4) {
      const dr = d[i] - kr, dg = d[i + 1] - kg, db = d[i + 2] - kb;
      const dist = Math.sqrt(dr * dr + dg * dg + db * db);
      if (dist < tol) d[i + 3] = 0;
      else if (dist < tol + soft) d[i + 3] = Math.round(d[i + 3] * ((dist - tol) / soft));
    }
    kctx.putImageData(img, 0, 0);
    ctx.drawImage(cv, dx, dy, dw, dh);
  } catch { try { ctx.drawImage(el, dx, dy, dw, dh); } catch { /* */ } }
}
function drawFx(ctx: CanvasRenderingContext2D, fx: string | undefined, W: number, H: number) {
  switch (fx) {
    case "flash": ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, W, H); break;
    case "tint": ctx.fillStyle = "rgba(255,120,40,0.25)"; ctx.fillRect(0, 0, W, H); break;
    case "coolTint": ctx.fillStyle = "rgba(40,120,255,0.22)"; ctx.fillRect(0, 0, W, H); break;
    case "fadeBlack": ctx.fillStyle = "#000"; ctx.fillRect(0, 0, W, H); break;
    case "blackbars": { const bar = H * 0.12; ctx.fillStyle = "#000"; ctx.fillRect(0, 0, W, bar); ctx.fillRect(0, H - bar, W, bar); break; }
    case "glow": { const g = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.max(W, H) * 0.6); g.addColorStop(0, "rgba(255,255,255,0.28)"); g.addColorStop(1, "rgba(255,255,255,0)"); ctx.fillStyle = g; ctx.fillRect(0, 0, W, H); break; }
    case "dark": ctx.fillStyle = "rgba(0,0,0,0.4)"; ctx.fillRect(0, 0, W, H); break;
    case "topShade": { const g = ctx.createLinearGradient(0, 0, 0, H * 0.4); g.addColorStop(0, "rgba(0,0,0,0.7)"); g.addColorStop(1, "rgba(0,0,0,0)"); ctx.fillStyle = g; ctx.fillRect(0, 0, W, H * 0.4); break; }
    case "bottomShade": { const g = ctx.createLinearGradient(0, H, 0, H * 0.6); g.addColorStop(0, "rgba(0,0,0,0.7)"); g.addColorStop(1, "rgba(0,0,0,0)"); ctx.fillStyle = g; ctx.fillRect(0, H * 0.6, W, H * 0.4); break; }
    default: { // vignette
      const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.max(W, H) * 0.72);
      g.addColorStop(0, "rgba(0,0,0,0)"); g.addColorStop(1, "rgba(0,0,0,0.78)");
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    }
  }
}

function fontPxBase(W: number, H: number, st: TextStyle, c: ExportClip, v: { scaleMul: number }) { return Math.max(14, (H * 9) / 256) * (st.size ?? 1) * (c.scale || 1) * v.scaleMul; }
function easeOutCubic(p: number) { return 1 - Math.pow(1 - p, 3); }
function easeOutBack(p: number) { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2); }

// Draw a styled caption (plate / word-highlight / karaoke / stroke / shadow / enter animations).
export function drawCaption(ctx: CanvasRenderingContext2D, c: ExportClip, tt: number, W: number, H: number, _sx: number, v: { opacity: number; scaleMul: number; offX: number; offY: number }): { x: number; y: number; w: number; h: number } | null {
  const st = c.tstyle || {};
  let text = c.text || ""; if (st.upper) text = text.toUpperCase();
  if (st.noPunct) text = text.replace(/[.,!?;:…"'„“”«»]/g, "");
  if (!text.trim()) return null;
  const local = tt - c.start;
  const fontPx = Math.max(14, (H * 9) / 256) * (st.size ?? 1) * (c.scale || 1) * v.scaleMul;
  const family = st.font || "sans-serif";
  const weight = st.weight ?? 800;
  ctx.font = `${weight} ${Math.round(fontPx)}px ${family}`;
  ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";

  // entrance
  let alpha = 1, scl = 1, typeChars = Infinity, slideY = 0, rot = 0, wipe: "" | "r" | "l" = "", blurPx = 0, wipeProgress = 1;
  const ep = Math.min(1, local / 0.28);
  const eo = easeOutCubic(ep);
  if (st.enter === "fade") alpha = ep;
  else if (st.enter === "scale") scl = 0.6 + 0.4 * eo;
  else if (st.enter === "zoomIn") { scl = 1.7 - 0.7 * eo; alpha = ep; }
  else if (st.enter === "bounce") scl = Math.max(0.01, easeOutBack(ep));
  else if (st.enter === "spin") { rot = (1 - eo) * 0.6; alpha = ep; scl = 0.7 + 0.3 * eo; }
  else if (st.enter === "wipeRight") { wipe = "r"; wipeProgress = eo; }
  else if (st.enter === "wipeLeft") { wipe = "l"; wipeProgress = eo; }
  else if (st.enter === "blurIn") { blurPx = (1 - eo) * 10; alpha = Math.max(0.2, ep); }
  else if (st.enter === "slideUp") { alpha = ep; slideY = (1 - eo) * fontPxBase(W, H, st, c, v) * 1.4; }
  else if (st.enter === "slideDown") { alpha = ep; slideY = -(1 - eo) * fontPxBase(W, H, st, c, v) * 1.4; }
  else if (st.enter === "typewriter") { const td = Math.min(0.9, c.duration * 0.6); typeChars = Math.max(1, Math.floor((Math.min(1, local / td)) * text.length)); }
  const wordsUp = st.enter === "wordsUp";
  // exit (last 0.28s of the clip) — mirrors the entrances
  if (st.exit) {
    const eq = Math.max(0, Math.min(1, (c.duration - local) / 0.28)); // 1 → playing, 0 → gone
    if (eq < 1) {
      const op = 1 - easeOutCubic(eq);
      if (st.exit === "fade") alpha *= eq;
      else if (st.exit === "scale") { scl *= 0.6 + 0.4 * eq; alpha *= eq; }
      else if (st.exit === "zoomOut") { scl *= 1 + 0.7 * op; alpha *= eq; }
      else if (st.exit === "slideUp") { slideY -= op * fontPxBase(W, H, st, c, v) * 1.4; alpha *= eq; }
      else if (st.exit === "slideDown") { slideY += op * fontPxBase(W, H, st, c, v) * 1.4; alpha *= eq; }
      else if (st.exit === "wipeLeft") wipe = wipe || "r"; // shrink from the right edge
      else if (st.exit === "wipeRight") wipe = wipe || "l";
      else if (st.exit === "blurOut") { blurPx = Math.max(blurPx, op * 10); alpha *= Math.max(0.2, eq); }
      if (st.exit === "wipeLeft" || st.exit === "wipeRight") {
        // reuse the clip-rect mechanism with the closing progress
        wipeProgress = Math.min(wipeProgress, eq);
      }
    }
  }
  // loop — continuous subtle motion for the whole clip
  if (st.loop === "pulse") scl *= 1 + 0.035 * Math.sin(local * 4);
  else if (st.loop === "float") slideY += Math.sin(local * 2.2) * fontPxBase(W, H, st, c, v) * 0.12;
  else if (st.loop === "wiggle") rot += 0.035 * Math.sin(local * 3);

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
  const cx = W / 2 + (c.x || 0) * W + v.offX * W;
  const pos = st.pos || "bottom";
  // last-line baseline so the text block matches the preview anchor
  let lastBaseline: number;
  if (pos === "top") lastBaseline = H * 0.10 + ascent + (n - 1) * lineH;
  else if (pos === "center") lastBaseline = H * 0.5 + (n * lineH) / 2 - descent;
  else lastBaseline = H * 0.85 - descent;
  const cy = lastBaseline + (c.y || 0) * H + v.offY * H;

  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, alpha * v.opacity));
  const blockH = n * lineH;
  ctx.translate(0, slideY);
  ctx.translate(cx, cy - blockH / 2); ctx.scale(scl, scl); if (rot) ctx.rotate(rot); ctx.translate(-cx, -(cy - blockH / 2));
  if (wipe) { const ww = W * Math.max(0, Math.min(1, wipeProgress)); ctx.beginPath(); if (wipe === "r") ctx.rect(0, 0, ww, H); else ctx.rect(W - ww, 0, ww, H); ctx.clip(); }
  if (blurPx > 0.3) ctx.filter = `blur(${blurPx.toFixed(1)}px)`;

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
    // Line alignment inside the block: center (default) / left / right.
    const blockW = Math.max(...lines.map((l) => l.words.reduce((s, w, i) => s + w.width + (i ? space : 0), 0)), 1);
    const align = st.align || "center";
    let x = align === "left" ? cx - blockW / 2 : align === "right" ? cx + blockW / 2 - lw : cx - lw / 2;
    const yBottom = cy - (lines.length - 1 - li) * lineH;
    if (st.plate === "full") {
      ctx.save(); ctx.shadowColor = "transparent";
      ctx.fillStyle = st.plateColor || "rgba(0,0,0,0.75)";
      const b = boxFor(ln.words.map((w) => w.w).join(" "), yBottom, padY);
      rrect(x - padX, b.top, lw + padX * 2, b.h, rad); ctx.fill(); ctx.restore();
    }
    for (const wo of ln.words) {
      const isActive = wo.idx === activeIdx;
      let wAlpha = 1, wDy = 0;
      if (wordsUp) {
        const epw = Math.max(0, Math.min(1, (local - wo.idx * 0.07) / 0.22));
        wAlpha = epw; wDy = (1 - easeOutCubic(epw)) * fontPx * 0.6;
        if (epw <= 0) { x += wo.width + space; continue; }
      }
      const prevAlpha = ctx.globalAlpha;
      if (wordsUp) ctx.globalAlpha = prevAlpha * wAlpha;
      const yW = yBottom + wDy;
      if (st.plate === "word" && isActive) {
        ctx.save(); ctx.shadowColor = "transparent";
        ctx.fillStyle = st.plateColor || "#FFD60A";
        const b = boxFor(wo.w, yW, padY * 0.85);
        rrect(x - padX * 0.5, b.top, wo.width + padX, b.h, rad); ctx.fill(); ctx.restore();
      }
      if (st.shadow !== false) { ctx.shadowColor = st.shadowColor || "rgba(0,0,0,0.85)"; ctx.shadowBlur = fontPx * 0.18; ctx.shadowOffsetY = fontPx * 0.05; } else ctx.shadowColor = "transparent";
      const swFrac = st.strokeW ?? 0.08;
      if (st.stroke && swFrac > 0) { ctx.lineJoin = "round"; ctx.lineWidth = fontPx * swFrac; ctx.strokeStyle = st.stroke; ctx.strokeText(wo.w, x, yW); }
      ctx.fillStyle = isActive && st.highlight ? st.highlight : (st.plate === "word" && isActive ? "#111" : (st.color || "#fff"));
      ctx.fillText(wo.w, x, yW);
      if (wordsUp) ctx.globalAlpha = prevAlpha;
      x += wo.width + space;
    }
  });
  ctx.filter = "none";
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

  // Prefetch every media source fully into a local Blob first. Rendering
  // seeks videos frame by frame - against a network-backed <video> every seek
  // stalls on HTTP range requests (minutes per version + crashes); against a
  // local blob: URL seeks are near-instant.
  const blobCache = new Map<string, { blob: Blob; objUrl: string }>();
  const prefetch = async (url: string): Promise<string> => {
    const hit = blobCache.get(url);
    if (hit) return hit.objUrl;
    try {
      const r = await fetch(corsUrl(url));
      if (!r.ok) throw new Error(String(r.status));
      const blob = await r.blob();
      const objUrl = URL.createObjectURL(blob);
      blobCache.set(url, { blob, objUrl });
      return objUrl;
    } catch { return corsUrl(url); } // stream from network as a last resort
  };
  const urls = Array.from(new Set(clips.filter((c) => c.url).map((c) => c.url!)));
  await Promise.all(urls.map((u) => prefetch(u)));

  // preload media (from the local blobs)
  const videos = new Map<string, HTMLVideoElement>();
  const images = new Map<string, HTMLImageElement>();
  const audios = new Map<string, HTMLAudioElement>();
  for (const c of clips) {
    if (!c.url) continue;
    const src = await prefetch(c.url);
    if (c.kind === "video") videos.set(c.id, await loadVideoEl(src));
    else if (c.kind === "image") images.set(c.id, await loadImgEl(src));
    else if (c.kind === "audio") audios.set(c.id, await loadAudioEl(src));
  }

  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d context");
  const tcanvas = document.createElement("canvas");
  tcanvas.width = W; tcanvas.height = H;
  const tctx = tcanvas.getContext("2d");
  if (!tctx) throw new Error("no 2d context");

  // One draw pass shared by both render paths (offline WebCodecs + realtime).
  const drawFrame = (tt: number) => {
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
            // Fit mode drives how media adapts to THIS canvas aspect, so one
            // layout renders correctly in every format. Default: video fills
            // (cover), images fit whole (contain). x/y/scale are fine offsets.
            const fitMode = c.fit ?? (c.kind === "video" ? "cover" : "contain");
            const ratio = fitMode === "cover" ? Math.max(W / mw, H / mh) : Math.min(W / mw, H / mh);
            const fit = ratio * (c.scale || 1) * v.scaleMul;
            const dw = mw * fit, dh = mh * fit;
            const dx = (W - dw) / 2 + (c.x || 0) * W + v.offX * W;
            const dy = (H - dh) / 2 + (c.y || 0) * H + v.offY * H;
            if (c.blend === "screen" || c.blend === "multiply") ctx.globalCompositeOperation = c.blend;
            // "blur" fills the letterbox bars with a blurred cover copy behind.
            if (fitMode === "blur") {
              const cov = Math.max(W / mw, H / mh) * (c.scale || 1) * v.scaleMul;
              const bw = mw * cov, bh = mh * cov;
              ctx.save();
              ctx.filter = `blur(${Math.max(8, Math.round(W / 50))}px)`;
              try { ctx.drawImage(el, (W - bw) / 2 + (c.x || 0) * W + v.offX * W, (H - bh) / 2 + (c.y || 0) * H + v.offY * H, bw, bh); } catch { /* */ }
              ctx.restore();
            }
            if (c.keyColor) drawKeyed(ctx, el, c, dx, dy, dw, dh);
            else { try { ctx.drawImage(el, dx, dy, dw, dh); } catch { /* */ } }
            ctx.globalCompositeOperation = "source-over";
          }
        }
      } else if (c.kind === "text") {
        drawCaption(ctx, c, tt, W, H, sx, { opacity: v.opacity, scaleMul: 1, offX: 0, offY: 0 });
      }
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  };

  const cleanupMedia = () => {
    for (const v of videos.values()) { try { v.pause(); v.removeAttribute("src"); v.load(); } catch { /* */ } }
    for (const a of audios.values()) { try { a.pause(); a.removeAttribute("src"); a.load(); } catch { /* */ } }
    for (const e of blobCache.values()) { try { URL.revokeObjectURL(e.objUrl); } catch { /* */ } }
    blobCache.clear();
  };

  // ---- Path 1: OFFLINE frame-by-frame render via WebCodecs ------------------
  // Deterministic (each frame is seeked, drawn and encoded explicitly), does
  // not depend on wall-clock playback, usually faster than realtime and keeps
  // working when the tab is in the background (no requestAnimationFrame).
  const wc = typeof window !== "undefined"
    && typeof (window as unknown as { VideoEncoder?: unknown }).VideoEncoder === "function"
    && typeof (window as unknown as { AudioEncoder?: unknown }).AudioEncoder === "function";
  if (wc) {
    try {
      const res = await exportOffline();
      cleanupMedia();
      return res;
    } catch (e) {
      console.warn("[export] WebCodecs render failed - falling back to realtime capture:", e);
    }
  }
  const res = await exportRealtime();
  cleanupMedia();
  return res;

  // Seek every video that is active at tt and wait for the frames to be ready.
  function seekActiveVideos(tt: number, fps: number): Promise<void> {
    const waits: Promise<void>[] = [];
    for (const c of clips) {
      if (c.kind !== "video") continue;
      const el = videos.get(c.id);
      if (!el) continue;
      if (!(tt >= c.start && tt < c.start + c.duration)) continue;
      const loc = Math.min(tt - c.start + (c.inset || 0), Math.max(0, (el.duration || 1e9) - 0.001));
      if (!el.seeking && Math.abs(el.currentTime - loc) <= 1 / (fps * 2)) continue;
      waits.push(new Promise<void>((res2) => {
        let done = false;
        const fin = () => { if (done) return; done = true; el.removeEventListener("seeked", fin); clearTimeout(tm); res2(); };
        const tm = setTimeout(fin, 800); // safety net - never hang on a bad seek (local blob seeks are fast)
        el.addEventListener("seeked", fin);
        try { el.currentTime = loc; } catch { fin(); }
      }));
    }
    return Promise.all(waits).then(() => undefined);
  }

  // Mix the whole audio track deterministically with OfflineAudioContext,
  // reproducing the preview volume curve (fades, transitions, gain > 100%).
  async function mixAudioOffline(): Promise<AudioBuffer | null> {
    const audible = clips.filter((c) => (c.kind === "video" || c.kind === "audio") && c.url && !c.muted && (c.volume ?? 1) > 0);
    if (!audible.length) return null;
    const sr = 48000;
    const octx = new OfflineAudioContext(2, Math.max(1, Math.ceil(total * sr)), sr);
    let any = false;
    for (const c of audible) {
      try {
        const cached = blobCache.get(c.url!);
        const ab = cached ? await cached.blob.arrayBuffer() : await (await fetch(corsUrl(c.url!))).arrayBuffer();
        const buf = await octx.decodeAudioData(ab);
        const src = octx.createBufferSource();
        src.buffer = buf;
        const g = octx.createGain();
        const base = c.volume ?? 1;
        const t0 = Math.max(0, c.start), t1 = c.start + c.duration;
        g.gain.setValueAtTime(0, 0);
        g.gain.setValueAtTime(Math.max(0, alphaAt(c, t0) * base), t0);
        for (let t = t0 + 0.05; t < t1; t += 0.05) g.gain.linearRampToValueAtTime(Math.max(0, alphaAt(c, t) * base), t);
        g.gain.linearRampToValueAtTime(0, t1);
        src.connect(g); g.connect(octx.destination);
        src.start(t0, Math.max(0, c.inset || 0), Math.max(0.01, c.duration));
        any = true;
      } catch { /* clip without decodable audio - skip */ }
    }
    if (!any) return null;
    return await octx.startRendering();
  }

  async function exportOffline(): Promise<{ blob: Blob; ext: string; mp4: boolean }> {
    const fps = 30;
    const { Muxer, ArrayBufferTarget } = await import("mp4-muxer");

    // pick a supported H.264 encoder config (highest profile/level first)
    const codecs = ["avc1.640033", "avc1.640028", "avc1.4d0028", "avc1.42001f"];
    let codec = "";
    for (const cdc of codecs) {
      try {
        const sup = await VideoEncoder.isConfigSupported({ codec: cdc, width: W, height: H, framerate: fps, bitrate: 10_000_000 });
        if (sup.supported) { codec = cdc; break; }
      } catch { /* */ }
    }
    if (!codec) throw new Error("no supported H.264 encoder config");

    const audioBuf = await mixAudioOffline();

    const muxer = new Muxer({
      target: new ArrayBufferTarget(),
      video: { codec: "avc", width: W, height: H },
      ...(audioBuf ? { audio: { codec: "aac" as const, numberOfChannels: 2, sampleRate: 48000 } } : {}),
      fastStart: "in-memory",
    });

    let encError: Error | null = null;
    const venc = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error: (e) => { encError = e as Error; },
    });
    venc.configure({ codec, width: W, height: H, framerate: fps, bitrate: 10_000_000 });

    if (audioBuf) {
      let aErr: Error | null = null;
      const aenc = new AudioEncoder({
        output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
        error: (e) => { aErr = e as Error; },
      });
      aenc.configure({ codec: "mp4a.40.2", sampleRate: 48000, numberOfChannels: 2, bitrate: 192_000 });
      const step = 24_000; // 0.5s per AudioData packet
      const ch0 = audioBuf.getChannelData(0);
      const ch1 = audioBuf.numberOfChannels > 1 ? audioBuf.getChannelData(1) : ch0;
      for (let off = 0; off < audioBuf.length; off += step) {
        const n = Math.min(step, audioBuf.length - off);
        const data = new Float32Array(n * 2);
        data.set(ch0.subarray(off, off + n), 0);
        data.set(ch1.subarray(off, off + n), n);
        const ad = new AudioData({ format: "f32-planar", sampleRate: 48000, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round((off / 48000) * 1e6), data });
        aenc.encode(ad);
        ad.close();
      }
      await aenc.flush();
      aenc.close();
      if (aErr) throw aErr;
    }

    // offline path drives videos purely by seeking - make sure nothing plays
    for (const v of videos.values()) { try { v.pause(); } catch { /* */ } }

    const totalFrames = Math.max(1, Math.round(total * fps));
    for (let f = 0; f < totalFrames; f++) {
      if (encError) throw encError;
      const tt = f / fps;
      await seekActiveVideos(tt, fps);
      drawFrame(tt);
      if (f === 0) {
        try { ctx!.getImageData(0, 0, 1, 1); }
        catch { throw new Error("canvas tainted (SecurityError) - CORS on the media bucket"); }
      }
      const frame = new VideoFrame(canvas, { timestamp: Math.round(tt * 1e6), duration: Math.round(1e6 / fps) });
      venc.encode(frame, { keyFrame: f % (fps * 2) === 0 });
      frame.close();
      // Backpressure via the encoder's dequeue event: timers are throttled in
      // background tabs, encoder callbacks are not.
      if (venc.encodeQueueSize > 4) {
        await new Promise<void>((res2) => venc.addEventListener("dequeue", () => res2(), { once: true }));
      }
      p.onProgress?.(f / totalFrames);
    }
    await venc.flush();
    venc.close();
    muxer.finalize();
    p.onProgress?.(1);
    const buffer = muxer.target.buffer;
    return { blob: new Blob([buffer], { type: "video/mp4" }), ext: "mp4", mp4: true };
  }

  // ---- Path 2 (fallback): realtime capture via MediaRecorder ----------------
  async function exportRealtime(): Promise<{ blob: Blob; ext: string; mp4: boolean }> {
    // audio graph - each element goes through its own GainNode so volumes above
    // 100% actually work (HTMLMediaElement.volume is clamped to 1 by browsers).
    let audioStream: MediaStream | null = null;
    let audioCtx: AudioContext | null = null;
    const gains = new Map<string, GainNode>();
    try {
      const AC: typeof AudioContext = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      audioCtx = new AC();
      await audioCtx.resume();
      const dest = audioCtx.createMediaStreamDestination();
      let any = false;
      for (const c of clips) {
        const el = c.kind === "video" ? videos.get(c.id) : c.kind === "audio" ? audios.get(c.id) : undefined;
        if (!el) continue;
        try {
          const src = audioCtx.createMediaElementSource(el);
          const g = audioCtx.createGain();
          g.gain.value = 0;
          src.connect(g); g.connect(dest);
          gains.set(c.id, g);
          any = true;
        } catch { /* */ }
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

    // Browsers throttle requestAnimationFrame to ~0 in background tabs while
    // MediaRecorder keeps recording wall-clock time. That produced frozen
    // stretches, overlong files, and skipped tail clips (e.g. the packshot)
    // whenever the tab lost focus mid-render. Mitigation: freeze the whole
    // export (recorder, media, and the virtual clock) while the tab is hidden
    // and resume seamlessly when it is visible again.
    let hiddenAccum = 0;
    let hiddenSince = 0;
    const onVis = () => {
      if (document.hidden) {
        hiddenSince = performance.now();
        try { if (rec.state === "recording") rec.pause(); } catch { /* */ }
        for (const v of videos.values()) { try { v.pause(); } catch { /* */ } }
        for (const a of audios.values()) { try { a.pause(); } catch { /* */ } }
      } else {
        if (hiddenSince) { hiddenAccum += performance.now() - hiddenSince; hiddenSince = 0; }
        try { if (rec.state === "paused") rec.resume(); } catch { /* */ }
      }
    };
    document.addEventListener("visibilitychange", onVis);

    // verify the canvas isn't tainted (cross-origin) early - draw 1 frame then read
    await new Promise<void>((resolve, reject) => {
      const draw = () => {
        if (document.hidden) { requestAnimationFrame(draw); return; }
        const tt = (performance.now() - startTs - hiddenAccum) / 1000;
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
            const vol = Math.max(0, alphaAt(c, tt) * (c.muted ? 0 : (c.volume ?? 1)));
            const g = gains.get(c.id);
            if (g) g.gain.value = vol; // GainNode supports >1 (volume boost)
            else { try { (el as HTMLMediaElement).volume = Math.min(1, vol); } catch { /* */ } }
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

        drawFrame(tt);

        // taint check on first frame
        if (tt < 0.1) {
          try { ctx!.getImageData(0, 0, 1, 1); }
          catch { reject(new Error("canvas tainted (SecurityError) - CORS on the media bucket")); return; }
        }
        requestAnimationFrame(draw);
      };
      requestAnimationFrame(draw);
    });

    document.removeEventListener("visibilitychange", onVis);
    rec.stop();
    for (const v of videos.values()) { try { v.pause(); } catch { /* */ } }
    for (const a of audios.values()) { try { a.pause(); } catch { /* */ } }
    try { await audioCtx?.close(); } catch { /* */ }

    const blob = await stopped;
    return { blob, ext: mp4 ? "mp4" : "webm", mp4 };
  }
}
