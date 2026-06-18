"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { alphaAt, clipVisual, TRANSITIONS, type CompClip } from "@/lib/editor/compositor";
import type { TextStyle, CapWord } from "@/lib/editor/exportVideo";
import { drawCaption, type ExportClip } from "@/lib/editor/exportVideo";
import {
  Music, Type, Plus, Trash2, Play, Pause, SkipBack,
  Download, Clapperboard, ZoomIn, ZoomOut, Loader2, Sparkles, Copy, Wand2,
  Scissors, Eye, EyeOff, Lock, Unlock, Folder, Subtitles, SlidersHorizontal, RefreshCw,
} from "lucide-react";
import TrackEditor from "@/components/canvas/TrackEditor";
import { correctedQuadAt, cornerPinMatrix3d, type TrackMode, type TrackKeyC } from "@/lib/track/correct";

export type EditorAsset = {
  id: string;
  url: string;
  kind: "video" | "image" | "audio";
  label: string;
  duration: number | null;
  category?: string;
  subpath?: string;
};

type LayerType = "video" | "image" | "text" | "effect" | "audio";
type Layer = { id: string; name?: string; type: LayerType; hidden?: boolean; locked?: boolean };
type Kind = "video" | "image" | "audio" | "text" | "fx" | "adjust";
const PRIO: Record<LayerType, number> = { effect: 0, text: 1, image: 2, video: 3, audio: 4 };
const TYPE_PREFIX: Record<LayerType, string> = { video: "V", image: "IMG", text: "T", effect: "FX", audio: "A" };
const clipLayerType = (k: Kind): LayerType => (k === "fx" || k === "adjust" ? "effect" : k === "audio" ? "audio" : k === "text" ? "text" : k === "image" ? "image" : "video");
const CAT_LABEL: Record<string, string> = { logo: "Logo", ui: "UI", store: "Store", graphic: "Graphic", overlay: "Overlay", music: "Music", sound: "Sound", reference: "Reference", hook: "Hook", body: "Body", packshot: "Packshot", other: "Other" };
const CAP_FONTS: { label: string; value: string }[] = [
  { label: "SF / System", value: "-apple-system, \"SF Pro Display\", system-ui, sans-serif" },
  { label: "Montserrat", value: "Montserrat, sans-serif" },
  { label: "Inter", value: "Inter, sans-serif" },
  { label: "Poppins", value: "Poppins, sans-serif" },
  { label: "Bebas Neue", value: "\"Bebas Neue\", sans-serif" },
  { label: "Anton", value: "Anton, sans-serif" },
  { label: "Archivo Black", value: "\"Archivo Black\", sans-serif" },
  { label: "Oswald", value: "Oswald, sans-serif" },
  { label: "Roboto Condensed", value: "\"Roboto Condensed\", sans-serif" },
  { label: "Sans", value: "sans-serif" },
  { label: "Arial Black", value: "\"Arial Black\", sans-serif" },
  { label: "Impact", value: "Impact, sans-serif" },
  { label: "Georgia", value: "Georgia, serif" },
  { label: "Mono", value: "ui-monospace, \"Courier New\", monospace" },
  { label: "Comic", value: "\"Comic Sans MS\", cursive" },
];
// ---- chroma-key preview renderers (same math as the exporter) ----
function keyHexToRgb(hex: string): [number, number, number] {
  const m = hex.replace("#", ""); const v = m.length === 3 ? m.split("").map((c) => c + c).join("") : m;
  const n = parseInt(v, 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function keyImageData(d: Uint8ClampedArray, keyColor: string, keyTol: number) {
  const [kr, kg, kb] = keyHexToRgb(keyColor);
  const tol = Math.max(0.02, Math.min(1, keyTol)) * 255 * 1.5; const soft = tol * 0.4;
  for (let i = 0; i < d.length; i += 4) {
    const dr = d[i] - kr, dg = d[i + 1] - kg, db = d[i + 2] - kb;
    const dist = Math.sqrt(dr * dr + dg * dg + db * db);
    if (dist < tol) d[i + 3] = 0;
    else if (dist < tol + soft) d[i + 3] = Math.round(d[i + 3] * ((dist - tol) / soft));
  }
}
function KeyedVideo({ url, keyColor, keyTol, register, onMeta }: { url: string; keyColor: string; keyTol: number; register: (el: HTMLVideoElement | null) => void; onMeta: (dur: number) => void }) {
  const vRef = useRef<HTMLVideoElement | null>(null);
  const cRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const v = vRef.current, cv = cRef.current;
      if (v && cv && v.readyState >= 2 && v.videoWidth) {
        const pw = Math.min(720, v.videoWidth), ph = Math.round(pw * (v.videoHeight / v.videoWidth));
        if (cv.width !== pw || cv.height !== ph) { cv.width = pw; cv.height = ph; }
        const ctx = cv.getContext("2d", { willReadFrequently: true });
        if (ctx) {
          try {
            ctx.clearRect(0, 0, pw, ph); ctx.drawImage(v, 0, 0, pw, ph);
            const img = ctx.getImageData(0, 0, pw, ph);
            keyImageData(img.data, keyColor, keyTol);
            ctx.putImageData(img, 0, 0);
          } catch { /* tainted → leave the raw frame */ }
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [keyColor, keyTol]);
  return (<>
    <video ref={(el) => { vRef.current = el; register(el); }} src={url} crossOrigin="anonymous" playsInline preload="metadata"
      onLoadedMetadata={(e) => onMeta(e.currentTarget.duration)}
      className="absolute inset-0 w-full h-full object-contain opacity-0 pointer-events-none" />
    <canvas ref={cRef} className="absolute inset-0 w-full h-full object-contain pointer-events-none" />
  </>);
}
function KeyedImage({ url, keyColor, keyTol }: { url: string; keyColor: string; keyTol: number }) {
  const cRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const img = new Image(); img.crossOrigin = "anonymous"; img.src = url;
    img.onload = () => {
      const cv = cRef.current; if (!cv) return;
      const pw = Math.min(1280, img.naturalWidth), ph = Math.round(pw * (img.naturalHeight / Math.max(1, img.naturalWidth)));
      cv.width = pw; cv.height = ph;
      const ctx = cv.getContext("2d", { willReadFrequently: true }); if (!ctx) return;
      try {
        ctx.drawImage(img, 0, 0, pw, ph);
        const d = ctx.getImageData(0, 0, pw, ph);
        keyImageData(d.data, keyColor, keyTol);
        ctx.putImageData(d, 0, 0);
      } catch { /* */ }
    };
  }, [url, keyColor, keyTol]);
  return <canvas ref={cRef} className="absolute inset-0 w-full h-full object-contain pointer-events-none" />;
}

// demo backdrop for effect/filter previews (inline SVG — no network)
const DEMO_BG = "url('data:image/svg+xml;utf8," + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2b5876"/><stop offset="1" stop-color="#4e4376"/></linearGradient></defs><rect width="160" height="90" fill="url(#g)"/><circle cx="118" cy="26" r="14" fill="#f6d365"/><path d="M0 70 L40 42 L75 64 L110 38 L160 60 L160 90 L0 90 Z" fill="#1f2d3d"/><path d="M0 78 L50 56 L95 74 L140 52 L160 62 L160 90 L0 90 Z" fill="#16202c"/></svg>`
) + "')";
const CAP_FONTS_CSS = "https://fonts.googleapis.com/css2?family=Montserrat:wght@400;600;700;800;900&family=Inter:wght@400;600;700;800;900&family=Poppins:wght@400;600;700;800;900&family=Bebas+Neue&family=Anton&family=Archivo+Black&family=Oswald:wght@400;600;700&family=Roboto+Condensed:wght@400;700&display=swap";
// keyword → emoji for auto-emoji captions
const EMOJI_DICT: [RegExp, string][] = [
  [/\b(money|cash|price|cost|pay|sale|deal)\b/i, "💸"], [/\b(free)\b/i, "🆓"],
  [/\b(phone|iphone|mobile)\b/i, "📱"], [/\b(storage|space|memory)\b/i, "💾"],
  [/\b(photo|photos|picture|camera)\b/i, "📸"], [/\b(video|videos)\b/i, "🎬"],
  [/\b(clean|cleaner|cleaning|junk|trash|garbage)\b/i, "🧹"], [/\b(delete|remove|erase)\b/i, "🗑️"],
  [/\b(fast|quick|speed|instant)\b/i, "⚡"], [/\b(slow|lag)\b/i, "🐌"],
  [/\b(love|loved|like)\b/i, "❤️"], [/\b(fire|hot|lit)\b/i, "🔥"],
  [/\b(new)\b/i, "✨"], [/\b(secret|hidden)\b/i, "🤫"], [/\b(stop|wait)\b/i, "✋"],
  [/\b(warning|careful|danger)\b/i, "⚠️"], [/\b(problem|issue|broken)\b/i, "😩"],
  [/\b(easy|simple)\b/i, "👌"], [/\b(best|top|number one)\b/i, "🏆"], [/\b(win|winner)\b/i, "🥇"],
  [/\b(grow|growth|increase|boost)\b/i, "📈"], [/\b(drop|decrease|down)\b/i, "📉"],
  [/\b(idea|tip|trick|hack)\b/i, "💡"], [/\b(brain|smart|genius)\b/i, "🧠"],
  [/\b(work|working|job)\b/i, "💼"], [/\b(time|minute|second|hour)\b/i, "⏰"],
  [/\b(check|done|ready)\b/i, "✅"], [/\b(wrong|no|never)\b/i, "❌"],
  [/\b(look|watch|see)\b/i, "👀"], [/\b(listen|hear|sound)\b/i, "🔊"],
  [/\b(food|eat|eating|hungry)\b/i, "🍔"], [/\b(coffee)\b/i, "☕"],
  [/\b(home|house)\b/i, "🏠"], [/\b(car|drive)\b/i, "🚗"], [/\b(travel|trip|fly)\b/i, "✈️"],
  [/\b(music|song)\b/i, "🎵"], [/\b(game|play|gaming)\b/i, "🎮"],
  [/\b(happy|smile|fun)\b/i, "😊"], [/\b(sad|cry)\b/i, "😢"], [/\b(crazy|insane|wild)\b/i, "🤯"],
  [/\b(strong|power|powerful)\b/i, "💪"], [/\b(gift|present|bonus)\b/i, "🎁"],
  [/\b(download|install|app)\b/i, "⬇️"], [/\b(link)\b/i, "🔗"], [/\b(now|today)\b/i, "👇"],
];
function emojiFor(text: string): string | null { for (const [re, e] of EMOJI_DICT) if (re.test(text)) return e; return null; }

// ---- timeline thumbnails: video filmstrips + audio waveforms (cached per URL) ----
const filmstripCache = new Map<string, string | null>();
const filmstripPending = new Set<string>();
async function makeFilmstrip(url: string): Promise<string | null> {
  if (filmstripCache.has(url)) return filmstripCache.get(url) ?? null;
  if (filmstripPending.has(url)) return null;
  filmstripPending.add(url);
  try {
    const v = document.createElement("video");
    v.crossOrigin = "anonymous"; v.muted = true; v.preload = "auto"; v.src = url;
    await new Promise<void>((res, rej) => { v.onloadedmetadata = () => res(); v.onerror = () => rej(new Error("load")); });
    const frames = 6, fh = 48, fw = Math.max(24, Math.round(fh * (v.videoWidth / Math.max(1, v.videoHeight))));
    const cv = document.createElement("canvas"); cv.width = fw * frames; cv.height = fh;
    const ctx = cv.getContext("2d"); if (!ctx) throw new Error("ctx");
    for (let i = 0; i < frames; i++) {
      const t = (v.duration || 1) * ((i + 0.5) / frames);
      await new Promise<void>((res) => { const on = () => { v.removeEventListener("seeked", on); res(); }; v.addEventListener("seeked", on); try { v.currentTime = Math.min(t, Math.max(0, (v.duration || 1) - 0.05)); } catch { res(); } });
      ctx.drawImage(v, i * fw, 0, fw, fh);
    }
    const data = cv.toDataURL("image/jpeg", 0.6);
    filmstripCache.set(url, data);
    return data;
  } catch { filmstripCache.set(url, null); return null; }
  finally { filmstripPending.delete(url); }
}
const wavePeaksCache = new Map<string, number[] | null>();
const wavePending = new Set<string>();
async function makeWavePeaks(url: string, buckets = 220): Promise<number[] | null> {
  if (wavePeaksCache.has(url)) return wavePeaksCache.get(url) ?? null;
  if (wavePending.has(url)) return null;
  wavePending.add(url);
  try {
    const ab = await fetch(url, { mode: "cors" }).then((r) => r.arrayBuffer());
    type ACtor = new () => AudioContext;
    const Ctx: ACtor = (window.AudioContext || (window as unknown as { webkitAudioContext: ACtor }).webkitAudioContext);
    const ac = new Ctx();
    const buf = await ac.decodeAudioData(ab);
    const ch = buf.getChannelData(0);
    const per = Math.max(1, Math.floor(ch.length / buckets));
    const peaks: number[] = [];
    for (let i = 0; i < buckets; i++) { let m = 0; const o = i * per; for (let j = 0; j < per; j += 50) { const v = Math.abs(ch[o + j] || 0); if (v > m) m = v; } peaks.push(m); }
    ac.close().catch(() => {});
    wavePeaksCache.set(url, peaks);
    return peaks;
  } catch { wavePeaksCache.set(url, null); return null; }
  finally { wavePending.delete(url); }
}

const CAP_PRESETS: { key: string; label: string; style: TextStyle }[] = [
  { key: "plain", label: "Plain", style: { color: "#fff", shadow: true, plate: "none", enter: "", weight: 800 } },
  { key: "stroke", label: "Stroke", style: { color: "#fff", stroke: "#000", strokeW: 0.11, shadow: false, plate: "none", upper: true, weight: 900, enter: "scale" } },
  { key: "plate", label: "Plate", style: { color: "#fff", plate: "full", plateColor: "rgba(0,0,0,0.78)", radius: 0.22, shadow: false, enter: "fade", weight: 800 } },
  { key: "highlight", label: "Highlight", style: { color: "#fff", plate: "word", plateColor: "#FFD60A", radius: 0.16, shadow: true, weight: 900, upper: true, enter: "" } },
  { key: "karaoke", label: "Karaoke", style: { color: "#fff", highlight: "#FFD60A", stroke: "#000", strokeW: 0.08, shadow: false, weight: 900, upper: true, enter: "" } },
  { key: "typewriter", label: "Typewriter", style: { color: "#fff", shadow: true, plate: "none", font: "ui-monospace, \"Courier New\", monospace", weight: 700, enter: "typewriter" } },
  { key: "hormozi", label: "Hormozi", style: { color: "#fff", plate: "word", plateColor: "#22C55E", radius: 0.1, stroke: "#000", strokeW: 0.06, weight: 900, upper: true, shadow: false } },
  { key: "boldYellow", label: "Bold Yellow", style: { color: "#FFD60A", stroke: "#000", strokeW: 0.12, weight: 900, upper: true, shadow: false, plate: "none" } },
  { key: "pop", label: "Pop", style: { color: "#fff", stroke: "#000", strokeW: 0.1, weight: 900, upper: true, shadow: false, enter: "bounce", plate: "none" } },
  { key: "boxed", label: "Boxed", style: { color: "#fff", plate: "full", plateColor: "#2563EB", radius: 0.4, weight: 800, shadow: false, enter: "scale" } },
  { key: "neon", label: "Neon", style: { color: "#39FF14", weight: 900, upper: true, shadow: true, plate: "none" } },
  { key: "minimal", label: "Minimal", style: { color: "#fff", weight: 600, shadow: false, plate: "none", size: 0.9 } },
];

type Word = { text: string; start: number; end: number }; // ms
// group transcript words into caption segments per mode → {text, start(s), dur(s), words(rel)}
type SplitMode = "word" | "two" | "three" | "smart" | "sentence" | "line";
function groupWords(words: Word[], mode: SplitMode): { text: string; start: number; dur: number; words: CapWord[] }[] {
  const out: { text: string; start: number; dur: number; words: CapWord[] }[] = [];
  const push = (ws: Word[]) => {
    if (!ws.length) return;
    const s = ws[0].start / 1000, e = ws[ws.length - 1].end / 1000;
    out.push({
      text: ws.map((w) => w.text).join(" "),
      start: +s.toFixed(3),
      dur: Math.max(0.3, +(e - s).toFixed(3)),
      words: ws.map((w) => ({ text: w.text, t: +((w.start / 1000) - s).toFixed(3), d: Math.max(0.08, +((w.end - w.start) / 1000).toFixed(3)) })),
    });
  };
  if (mode === "word") { for (const w of words) push([w]); return out; }
  if (mode === "two") { for (let i = 0; i < words.length; i += 2) push(words.slice(i, i + 2)); return out; }
  if (mode === "three") { for (let i = 0; i < words.length; i += 3) push(words.slice(i, i + 3)); return out; }
  if (mode === "sentence") {
    let buf: Word[] = [];
    for (const w of words) { buf.push(w); if (/[.!?…]$/.test(w.text)) { push(buf); buf = []; } }
    push(buf); return out;
  }
  // smart ~25 chars w/ punctuation; line ~40 chars (one full line per caption)
  const limit = mode === "line" ? 40 : 25;
  let buf: Word[] = [], len = 0;
  for (const w of words) {
    buf.push(w); len += w.text.length + 1;
    const ends = /[.!?,…]$/.test(w.text);
    if (len >= limit || (mode === "smart" && ends)) { push(buf); buf = []; len = 0; }
  }
  push(buf);
  return out;
}
type EditClip = {
  id: string;
  layer: string;
  kind: Kind;
  url?: string;
  text?: string;
  label: string;
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
  autoDur?: boolean;
  inset?: number; // media in-point (s) — used after razor splits and left-trim
  srcDur?: number; // full source media duration (s) — auto-detected, allows un-trim
  section?: string; // Hook | Body | Packshot | CTA — set by the canvas hand-off
  volume?: number; // 0..2, default 1
  muted?: boolean;
  blend?: string;    // "" | "screen" | "multiply"
  keyColor?: string; // chroma key color (hex)
  keyTol?: number;   // 0..1
  tstyle?: TextStyle;
  words?: CapWord[];
  // Screen-track (live corner-pin onto a green-screen clip's phone screen):
  trackTo?: string;            // id of the green-screen video clip to track onto
  trackKeys?: TrackKeyC[];     // correction keyframes (per-corner offsets)
  trackMode?: TrackMode;       // interpolation mode
};

const RESOLUTIONS = [
  { key: "9:16", label: "Portrait 9:16", w: 1080, h: 1920 },
  { key: "4:5", label: "Portrait 4:5", w: 1080, h: 1350 },
  { key: "16:9", label: "Landscape 16:9", w: 1920, h: 1080 },
  { key: "1:1", label: "Square 1:1", w: 1080, h: 1080 },
];
const DEFAULTS = { image: 4, audio: 6, video: 4, text: 3, fx: 1.5, adjust: 3 };
const MIN_DUR = 0.3;
const ANIMS = [
  { v: "", l: "None" }, { v: "kenBurns", l: "Ken Burns" }, { v: "zoomIn", l: "Zoom In" },
  { v: "zoomOut", l: "Zoom Out" }, { v: "slideL", l: "Slide ←" }, { v: "slideR", l: "Slide →" },
  { v: "pulse", l: "Pulse" }, { v: "shake", l: "Shake" }, { v: "panLeft", l: "Pan ←" },
  { v: "panRight", l: "Pan →" }, { v: "drift", l: "Drift" }, { v: "breathe", l: "Breathe" },
];
const FX = [
  { v: "vignette", l: "Vignette" }, { v: "flash", l: "Flash" }, { v: "fadeBlack", l: "Fade black" },
  { v: "tint", l: "Warm tint" }, { v: "coolTint", l: "Cool tint" }, { v: "blackbars", l: "Cinematic bars" },
  { v: "glow", l: "Glow" }, { v: "dark", l: "Darken" }, { v: "topShade", l: "Top shade" }, { v: "bottomShade", l: "Bottom shade" },
];
const ADJUST = [
  { v: "grayscale(1)", l: "B&W" }, { v: "sepia(0.8)", l: "Sepia" }, { v: "invert(1)", l: "Invert" },
  { v: "blur(6px)", l: "Blur" }, { v: "brightness(1.35)", l: "Bright" }, { v: "brightness(0.6)", l: "Dark" },
  { v: "contrast(1.5)", l: "Contrast" }, { v: "saturate(1.9)", l: "Saturate" }, { v: "hue-rotate(90deg)", l: "Hue shift" },
  { v: "sepia(0.4) contrast(1.2) saturate(1.3)", l: "Vintage" }, { v: "hue-rotate(-20deg) saturate(1.3)", l: "Cool" },
  { v: "sepia(0.3) saturate(1.2) brightness(1.05)", l: "Warm" }, { v: "contrast(1.5) brightness(0.9) saturate(1.2)", l: "Dramatic" },
  { v: "contrast(0.85) brightness(1.1) saturate(0.9)", l: "Faded" },
];

let _id = 0, _l = 0;
const uid = () => `c${Date.now()}_${_id++}`;
const fmt = (s: number) => `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, "0")}`;

export default function VideoEditor({ assets, workflowId, projectId }: { assets: EditorAsset[]; workflowId?: string; projectId?: string }) {
  const [layers, setLayers] = useState<Layer[]>([{ id: "v1", type: "video" }, { id: "a1", type: "audio" }]);
  const [selectedLayer, setSelectedLayer] = useState<string | null>(null);
  const [renamingLayer, setRenamingLayer] = useState<string | null>(null);
  const [clips, setClips] = useState<EditClip[]>([]);
  // Per-source green-screen track cache (auto-track quads), keyed by clip URL.
  const [trackCache, setTrackCache] = useState<Record<string, { fps: number; w: number; h: number; quads: number[][][] } | "loading" | "error">>({});
  const [trackOpen, setTrackOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const selected = selectedIds.length ? selectedIds[selectedIds.length - 1] : null;
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const marqueeRef = useRef<{ x0: number; y0: number } | null>(null);
  const [binFilter, setBinFilter] = useState<"all" | "video" | "image" | "audio">("all");
  const [library, setLibrary] = useState<EditorAsset[]>(assets);
  const [binQuery, setBinQuery] = useState("");
  const [binBrand, setBinBrand] = useState("");
  const [binProject, setBinProject] = useState("");
  const [binSource, setBinSource] = useState("");
  const [binCategory, setBinCategory] = useState("all");
  const [binSub, setBinSub] = useState("all");
  const [binSort, setBinSort] = useState<"newest" | "oldest" | "az" | "za" | "kind" | "duration">("newest");
  const [binAspect, setBinAspect] = useState<string>("all");
  const [brandQ, setBrandQ] = useState("");
  const [brands, setBrands] = useState<{ value: string; label: string }[]>([]);
  const [projects, setProjects] = useState<{ value: string; label: string }[]>([]);
  const [binLoading, setBinLoading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [resKey, setResKey] = useState("9:16");
  const [pxPerSec, setPxPerSec] = useState(60);
  const [laneH, setLaneH] = useState(48); // track height (vertical timeline zoom)
  const [leftW, setLeftW] = useState(240);   // library panel width (0 = collapsed)
  const [rightW, setRightW] = useState(256); // tools panel width (0 = collapsed)
  const dragPanel = (side: "left" | "right") => (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX, startW = side === "left" ? leftW : rightW;
    const move = (ev: PointerEvent) => {
      const d = side === "left" ? ev.clientX - startX : startX - ev.clientX;
      const w = Math.min(440, Math.max(180, startW + d));
      if (side === "left") setLeftW(w); else setRightW(w);
    };
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  };
  const [playing, setPlaying] = useState(false);
  const [playhead, setPlayhead] = useState(0);
  const [previewSize, setPreviewSize] = useState({ w: 0, h: 0 });
  const capCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const [dropHint, setDropHint] = useState<{ type: "lane" | "strip"; id: string } | null>(null);
  const [railTab, setRailTab] = useState<"media" | "brand" | "audio" | "text" | "subs" | "effects" | "filters">("media");
  const [brandLib, setBrandLib] = useState<EditorAsset[]>([]);
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncMsg, setSyncMsg] = useState("");
  const [embedMsg, setEmbedMsg] = useState("");
  const embedLoopRef = useRef(false);
  // background semantic indexing of fast-synced videos/audio — fire and forget
  const startEmbedLoop = useCallback(async (brandId: string) => {
    if (embedLoopRef.current || !brandId) return;
    embedLoopRef.current = true;
    try {
      for (let i = 0; i < 200; i++) {
        const r = await fetch("/api/brand-assets/embed-skipped", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ brandId }) });
        const j = (await r.json()) as { ok?: boolean; started?: number; remaining?: number; error?: string };
        if (!r.ok || j.error) { setEmbedMsg(""); break; }
        if (!j.remaining) { setEmbedMsg(j.started || i > 0 ? "Semantic indexing done." : ""); setTimeout(() => setEmbedMsg(""), 4000); break; }
        setEmbedMsg(`Indexing for search… ${j.remaining} left`);
      }
    } catch { setEmbedMsg(""); }
    embedLoopRef.current = false;
  }, []);
  const [subSource, setSubSource] = useState<string>("");
  const [subMode, setSubMode] = useState<SplitMode>("smart");
  const [subEmoji, setSubEmoji] = useState(false);
  const [savedPresets, setSavedPresets] = useState<{ name: string; style: TextStyle }[]>([]);
  const [capRects, setCapRects] = useState<{ id: string; x: number; y: number; w: number; h: number }[]>([]);
  const [thumbTick, setThumbTick] = useState(0); // bumps when a filmstrip/waveform finishes
  const [dims, setDims] = useState<Record<string, string>>({}); // url → "1080×1920" (auto-detected)
  const noteDims = (url: string, w: number, h: number) => { if (w && h) setDims((p) => (p[url] ? p : { ...p, [url]: `${w}×${h}` })); };
  // Eagerly measure media dimensions for the asset bins so the aspect-ratio
  // filter can bucket assets even before their thumbnail scrolls into view.
  useEffect(() => {
    const els: HTMLMediaElement[] = [];
    for (const a of [...library, ...brandLib]) {
      if (dims[a.url]) continue;
      if (a.kind === "image") {
        const img = new Image();
        img.onload = () => noteDims(a.url, img.naturalWidth, img.naturalHeight);
        img.src = a.url;
      } else if (a.kind === "video") {
        const v = document.createElement("video");
        v.preload = "metadata"; v.muted = true;
        v.onloadedmetadata = () => noteDims(a.url, v.videoWidth, v.videoHeight);
        v.src = a.url; els.push(v);
      }
    }
    return () => { els.forEach((e) => { e.onloadedmetadata = null; e.src = ""; }); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [library, brandLib]);
  const requestFilmstrip = (url: string) => { if (!filmstripCache.has(url) && !filmstripPending.has(url)) makeFilmstrip(url).then(() => setThumbTick((v) => v + 1)); };
  const requestWave = (url: string) => { if (!wavePeaksCache.has(url) && !wavePending.has(url)) makeWavePeaks(url).then(() => setThumbTick((v) => v + 1)); };
  void thumbTick;
  const [subBusy, setSubBusy] = useState(false);
  const [subStatus, setSubStatus] = useState("");
  const [capPreset, setCapPreset] = useState("highlight");
  const [capStyle, setCapStyle] = useState<TextStyle>(CAP_PRESETS.find((p) => p.key === "highlight")!.style);
  const [transMenu, setTransMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const [timelineH, setTimelineH] = useState(208);
  const resizeRef = useRef<{ startY: number; startH: number } | null>(null);
  const onResizeDown = (e: React.PointerEvent) => { e.preventDefault(); resizeRef.current = { startY: e.clientY, startH: timelineH }; (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId); };
  const onResizeMove = (e: React.PointerEvent) => { const r = resizeRef.current; if (!r) return; const dh = r.startY - e.clientY; setTimelineH(Math.max(140, Math.min(typeof window !== "undefined" ? window.innerHeight * 0.7 : 700, r.startH + dh))); };
  const onResizeUp = () => { resizeRef.current = null; };

  const laneRefs = useRef<Map<string, HTMLElement>>(new Map());
  const stripRefs = useRef<Map<string, HTMLElement>>(new Map());
  const dropHintRef = useRef<typeof dropHint>(null);
  dropHintRef.current = dropHint;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const mediaRefs = useRef<Map<string, HTMLVideoElement | HTMLAudioElement>>(new Map());
  const rafRef = useRef<number | null>(null);
  const lastRenderRef = useRef(0);
  const lastTsRef = useRef(0);
  const playingRef = useRef(false);
  const playheadRef = useRef(0);
  const clipsRef = useRef<EditClip[]>([]);
  const selectedRef = useRef<string[]>([]);
  clipsRef.current = clips;
  selectedRef.current = selectedIds;

  const res = RESOLUTIONS.find((r) => r.key === resKey)!;
  const sortBin = (arr: EditorAsset[]) => {
    if (binSort === "newest") return arr;
    if (binSort === "oldest") return [...arr].reverse();
    return [...arr].sort((a, b) =>
      binSort === "az" ? a.label.localeCompare(b.label)
      : binSort === "za" ? b.label.localeCompare(a.label)
      : binSort === "duration" ? (b.duration ?? 0) - (a.duration ?? 0)
      : a.kind.localeCompare(b.kind) || a.label.localeCompare(b.label));
  };
  const extOf = (url: string) => { const m = url.split("?")[0].match(/\.([a-z0-9]{2,4})$/i); return m ? m[1].toUpperCase() : ""; };
  // Aspect-ratio bucket from the measured pixel size (audio always passes).
  const aspectBucket = (url: string): string | null => {
    const d = dims[url]; if (!d) return null;
    const m = d.match(/(\d+)×(\d+)/); if (!m) return null;
    const w = +m[1], h = +m[2]; if (!w || !h) return null;
    const r = w / h;
    const near = (t: number) => Math.abs(r - t) / t < 0.06;
    if (near(1)) return "1:1";
    if (near(4 / 5)) return "4:5";
    if (near(9 / 16)) return "9:16";
    if (near(16 / 9)) return "16:9";
    if (near(3 / 4)) return "3:4";
    if (near(2 / 3)) return "2:3";
    return r < 1 ? "Portrait" : "Landscape";
  };
  const matchAspect = (a: EditorAsset) => binAspect === "all" || a.kind === "audio" || aspectBucket(a.url) === binAspect;
  const mediaBin = sortBin(library.filter((a) => (binFilter === "all" || a.kind === binFilter) && matchAspect(a)));
  const brandQl = brandQ.trim().toLowerCase();
  const brandBin = sortBin(brandLib.filter((a) =>
    (!brandQl || a.label.toLowerCase().includes(brandQl) || (a.subpath || "").toLowerCase().includes(brandQl)) &&
    (binFilter === "all" || a.kind === binFilter) &&
    (binCategory === "all" || a.category === binCategory) &&
    (binSub === "all" || (a.subpath || "").split("/")[0] === binSub) &&
    matchAspect(a)));
  const audioBin = sortBin([...library, ...brandLib].filter((a) => a.kind === "audio"));
  const libSubs = binCategory === "all" ? [] : Array.from(new Set(brandLib.filter((a) => a.category === binCategory && a.subpath).map((a) => (a.subpath as string).split("/")[0]))).sort();
  const libCats = Array.from(new Set(brandLib.map((a) => a.category).filter((c): c is string => !!c)));
  const selTextCount = selectedIds.filter((id) => clips.find((c) => c.id === id)?.kind === "text").length;
  // ---- undo/redo (snapshots of clips+layers, debounced) ----
  const histRef = useRef<{ clips: EditClip[]; layers: Layer[] }[]>([]);
  const histPosRef = useRef(-1);
  const restoringRef = useRef(false);
  useEffect(() => {
    if (restoringRef.current) { restoringRef.current = false; return; }
    const tmo = setTimeout(() => {
      const h = histRef.current.slice(0, histPosRef.current + 1);
      const last = h[h.length - 1];
      if (last && last.clips === clips && last.layers === layers) return;
      h.push({ clips, layers });
      if (h.length > 60) h.shift();
      histRef.current = h; histPosRef.current = h.length - 1;
    }, 250);
    return () => clearTimeout(tmo);
  }, [clips, layers]);
  const undo = useCallback(() => {
    if (histPosRef.current <= 0) return;
    histPosRef.current -= 1; const s = histRef.current[histPosRef.current];
    restoringRef.current = true; setClips(s.clips); setLayers(s.layers); setSelectedIds([]);
  }, []);
  const redo = useCallback(() => {
    if (histPosRef.current >= histRef.current.length - 1) return;
    histPosRef.current += 1; const s = histRef.current[histPosRef.current];
    restoringRef.current = true; setClips(s.clips); setLayers(s.layers); setSelectedIds([]);
  }, []);

  // generated + uploaded assets (the "Media" tab)
  const loadGen = async (over: Partial<{ q: string; brand: string; project: string; source: string }> = {}) => {
    const q = over.q ?? binQuery, brand = over.brand ?? binBrand, project = over.project ?? binProject, source = over.source ?? binSource;
    setBinLoading(true);
    try {
      const p = new URLSearchParams(); p.set("limit", "600");
      if (q.trim()) p.set("q", q.trim());
      if (brand) p.set("brand", brand);
      if (project) p.set("project", project);
      if (source) p.set("source", source);
      const r = await fetch(`/api/assets?${p.toString()}`);
      const aj = (await r.json()) as { assets?: { id: string; cdnUrl: string; kind: string; prompt: string | null; brandName: string | null; durationSec: number | null }[]; brands?: { value: string; label: string }[]; projects?: { value: string; label: string }[] };
      const items: EditorAsset[] = [];
      const seen = new Set<string>();
      for (const a of aj.assets || []) {
        if (!a.cdnUrl || seen.has(a.cdnUrl)) continue; if (!(a.kind === "video" || a.kind === "image" || a.kind === "audio")) continue;
        seen.add(a.cdnUrl); items.push({ id: a.id, url: a.cdnUrl, kind: a.kind as EditorAsset["kind"], label: a.prompt || a.brandName || a.kind, duration: a.durationSec ?? null });
      }
      setLibrary(items);
      if (Array.isArray(aj.brands)) setBrands(aj.brands);
      if (Array.isArray(aj.projects)) setProjects(aj.projects);
    } catch { /* keep current */ } finally { setBinLoading(false); }
  };
  // curated brand-kit assets (the "Brand" tab) — category/subfolder structured
  const loadBrand = async (brandOver?: string) => {
    const brand = brandOver ?? binBrand;
    setBinLoading(true);
    try {
      const bp = new URLSearchParams(); bp.set("limit", "200"); if (brand) bp.set("brandId", brand);
      const r = await fetch(`/api/brand-assets/browse?${bp.toString()}`);
      const bj = (await r.json()) as { assets?: { id: string; url: string; kind: string; category: string; subpath?: string | null; label: string | null }[] };
      const items: EditorAsset[] = [];
      const seen = new Set<string>();
      for (const x of bj.assets || []) {
        if (!x.url?.startsWith("http") || seen.has(x.url)) continue;
        seen.add(x.url); const kind: EditorAsset["kind"] = x.kind === "video" ? "video" : x.kind === "audio" ? "audio" : "image";
        items.push({ id: `ba-${x.id}`, url: x.url, kind, label: x.label || CAT_LABEL[x.category] || x.category || "asset", duration: null, category: x.category, subpath: x.subpath || undefined });
      }
      setBrandLib(items);
    } catch { /* keep current */ } finally { setBinLoading(false); }
  };
  const loadLibrary = async (over: Partial<{ q: string; brand: string; project: string; source: string }> = {}) => { await Promise.all([loadGen(over), loadBrand(over.brand)]); };
  // pull new files from Google Drive into the brand kit, batch by batch
  const syncFromDrive = async () => {
    if (!binBrand) { setSyncMsg("Pick a brand first."); return; }
    setSyncBusy(true); setSyncMsg("Checking Drive…");
    try {
      let total = 0;
      for (let i = 0; i < 60; i++) {
        const ctl = new AbortController();
        const tmo = setTimeout(() => ctl.abort(), 120000); // a batch should never take 2 min — bail and surface it
        const r = await fetch("/api/drive/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ brandId: binBrand }), signal: ctl.signal }).finally(() => clearTimeout(tmo));
        const j = (await r.json()) as { ok?: boolean; imported?: number; remaining?: number; newFound?: number; error?: string };
        if (!r.ok || j.error) { setSyncMsg(`Sync failed: ${j.error || r.status}`); setSyncBusy(false); return; }
        total += j.imported || 0;
        if (!j.remaining) { setSyncMsg(total ? `Imported ${total} new file${total === 1 ? "" : "s"}.` : "Up to date — nothing new."); startEmbedLoop(binBrand); break; }
        setSyncMsg(`Batch ${i + 1}: imported ${total} so far… ${j.remaining} left`);
      }
      await loadBrand();
    } catch (e) { setSyncMsg(e instanceof DOMException && e.name === "AbortError" ? "Batch timed out — press Sync Drive again to continue (progress is saved)." : `Sync failed: ${e instanceof Error ? e.message : "error"}`); }
    setSyncBusy(false);
  };
  useEffect(() => { loadLibrary(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);
  // ---- project persistence (localStorage): restore on open, autosave on change ----
  // One editor project per canvas workflow (standalone /editor keeps the legacy key)
  const PROJECT_KEY = workflowId ? `flowlab.editor.project.v1:${workflowId}` : "flowlab.editor.project.v1";
  const IMPORT_KEY = workflowId ? `flowlab.editor.import.v1:${workflowId}` : "flowlab.editor.import.v1";
  const restoredRef = useRef(false);
  const [saveState, setSaveState] = useState<"" | "saved" | "saving">("");
  useEffect(() => {
    if (restoredRef.current) return; restoredRef.current = true;
    // Canvas hand-off first: a send from the Editor node REPLACES this
    // workflow's project, so when it exists the regular restore is skipped.
    let imported = false;
    try {
      const rawImp = localStorage.getItem(IMPORT_KEY);
      if (rawImp) {
        localStorage.removeItem(IMPORT_KEY);
        const imp = JSON.parse(rawImp) as { tracks?: { kind: string; value: string; label: string; section?: string }[] };
        const tracks = (imp.tracks ?? []).filter((t) => t && typeof t.value === "string" && t.value);
        if (tracks.length) {
          // kind by URL extension first — port types lie (brand kit "image" port can carry mp4)
          const kindOf = (t: { kind: string; value: string }): Kind => {
            const v = t.value;
            if (!v.startsWith("http")) return "text";
            if (/\.(mp4|webm|mov|m4v)(\?|$)/i.test(v)) return "video";
            if (/\.(mp3|wav|m4a|aac|ogg|flac)(\?|$)/i.test(v)) return "audio";
            if (/\.(png|jpe?g|webp|gif|avif|svg)(\?|$)/i.test(v)) return "image";
            return t.kind === "video" ? "video" : t.kind === "audio" ? "audio" : t.kind === "text" ? "text" : "image";
          };
          const newLayers: Layer[] = [];
          const newClips: EditClip[] = [];
          tracks.forEach((t, i) => {
            if (t.kind === "captions") {
              // word-level transcript from the canvas Subtitles node
              try {
                const ws = JSON.parse(t.value) as { text: string; start: number; end: number }[];
                if (Array.isArray(ws) && ws.length) {
                  const lid = `timp_${Date.now()}_${i}_${_l++}`;
                  newLayers.push({ id: lid, type: "text", name: "Subtitles" });
                  const groups = groupWords(ws.map((w) => ({ text: w.text, start: Math.round(w.start * 1000), end: Math.round(w.end * 1000) })), "smart");
                  for (const g of groups) {
                    newClips.push({ id: uid(), kind: "text", layer: lid, label: g.text.slice(0, 24), start: g.start, duration: g.dur, fadeIn: 0, fadeOut: 0, scale: 1, x: 0, y: 0, text: g.text, words: g.words, tstyle: { color: "#ffffff", shadow: true, plate: "none", enter: "", weight: 800 } });
                  }
                }
              } catch { /* malformed words payload */ }
              return;
            }
            const kind = kindOf(t);
            const ltype = clipLayerType(kind);
            const lid = `${ltype[0]}imp_${Date.now()}_${i}_${_l++}`; // one fresh layer per track — guaranteed unique
            newLayers.push({ id: lid, type: ltype, ...(t.section ? { name: t.section } : {}) });
            const sec = t.section ? { section: t.section } : {};
            if (kind === "text") {
              newClips.push({ id: uid(), kind, layer: lid, label: t.label || "Text", start: 0, duration: DEFAULTS.text, fadeIn: 0, fadeOut: 0, scale: 1, x: 0, y: 0, text: t.value, tstyle: { color: "#ffffff", shadow: true, plate: "none", enter: "", weight: 700 }, ...sec });
            } else {
              newClips.push({ id: uid(), kind, layer: lid, url: t.value, label: t.label || kind, start: 0, duration: DEFAULTS[kind], fadeIn: 0, fadeOut: 0, scale: 1, x: 0, y: 0, ...(kind === "video" || kind === "audio" ? { autoDur: true } : {}), ...sec });
            }
          });
          if (!newLayers.some((l) => l.type === "video")) newLayers.push({ id: `vimp_${Date.now()}_${_l++}`, type: "video" });
          if (!newLayers.some((l) => l.type === "audio")) newLayers.push({ id: `aimp_${Date.now()}_${_l++}`, type: "audio" });
          setLayers(newLayers);
          setClips(newClips);
          setSelectedIds([]);
          if (newClips.some((c) => c.section)) sectionLayoutRef.current = true; // lay out sequentially once real durations arrive
          imported = true;
        }
      }
    } catch { /* malformed hand-off — ignore */ }
    if (imported) return;
    try {
      const raw = localStorage.getItem(PROJECT_KEY); if (!raw) return;
      const j = JSON.parse(raw) as { clips?: EditClip[]; layers?: Layer[]; resKey?: string };
      if (Array.isArray(j.clips) && j.clips.length && Array.isArray(j.layers) && j.layers.length) {
        setClips(j.clips); setLayers(j.layers);
        if (j.resKey && RESOLUTIONS.some((r) => r.key === j.resKey)) setResKey(j.resKey);
      }
    } catch { /* ignore corrupt saves */ }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const saveProject = useCallback(() => {
    try { localStorage.setItem(PROJECT_KEY, JSON.stringify({ clips: clipsRef.current, layers: layersRef.current, resKey })); setSaveState("saved"); setTimeout(() => setSaveState(""), 1500); } catch { /* quota */ }
  }, [resKey]);
  useEffect(() => {
    if (!restoredRef.current) return;
    setSaveState("saving");
    const t = setTimeout(() => { try { localStorage.setItem(PROJECT_KEY, JSON.stringify({ clips, layers, resKey })); setSaveState("saved"); setTimeout(() => setSaveState(""), 1200); } catch { setSaveState(""); } }, 1200);
    return () => clearTimeout(t);
  }, [clips, layers, resKey]);
  const newProject = () => {
    if (!window.confirm("Start a new project? The current timeline will be cleared (last autosave is overwritten).")) return;
    setClips([]); setSelectedIds([]); setLayers([{ id: "v1", type: "video" }, { id: "a1", type: "audio" }]); seek(0);
    try { localStorage.removeItem(PROJECT_KEY); } catch { /* */ }
  };
  // load caption webfonts + saved presets; redraw once fonts are ready
  const [fontsTick, setFontsTick] = useState(0);
  useEffect(() => {
    if (typeof document === "undefined") return;
    if (!document.querySelector('link[data-cap-fonts]')) {
      const l = document.createElement("link"); l.rel = "stylesheet"; l.href = CAP_FONTS_CSS; l.setAttribute("data-cap-fonts", "1"); document.head.appendChild(l);
    }
    document.fonts?.ready?.then(() => setFontsTick((v) => v + 1)).catch(() => {});
    try { const raw = localStorage.getItem("flowlab.capPresets"); if (raw) setSavedPresets(JSON.parse(raw)); } catch { /* ignore */ }
  }, []);
  // draw captions on the overlay canvas using the SAME routine as the exporter (pixel parity)
  useEffect(() => {
    const cv = capCanvasRef.current; if (!cv) return;
    const W = previewSize.w, H = previewSize.h; if (!W || !H) return;
    const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    const ctx = cv.getContext("2d"); if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const rects: { id: string; x: number; y: number; w: number; h: number }[] = [];
    const hiddenL = new Set(layers.filter((l) => l.hidden).map((l) => l.id));
    for (const c of clips) {
      if (c.kind !== "text" || hiddenL.has(c.layer)) continue;
      if (playhead < c.start || playhead >= c.start + c.duration) continue;
      const r = drawCaption(ctx, c as unknown as ExportClip, playhead, W, H, 1, { opacity: alphaAt(c as CompClip, playhead) || 1, scaleMul: 1, offX: 0, offY: 0 });
      if (r) rects.push({ id: c.id, ...r });
    }
    // interactive handles only when paused (kept light during playback)
    setCapRects((prev) => (playing ? (prev.length ? [] : prev) : rects));
  }, [clips, layers, playhead, previewSize.w, previewSize.h, playing, fontsTick]);
  const runSearch = async () => {
    const q = binQuery.trim();
    if (!q) { loadLibrary(); return; }
    setBinLoading(true);
    try {
      const r = await fetch("/api/semantic-search", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: q, brandId: binBrand || undefined, modality: binFilter !== "all" ? binFilter : undefined, limit: 60 }) });
      const j = (await r.json()) as { results?: { assetId: string | null; url: string; modality: string; category: string | null }[]; error?: string };
      if (!r.ok) throw new Error(j.error || "search failed");
      const items: EditorAsset[] = (j.results || [])
        .filter((x) => x.url && (x.modality === "video" || x.modality === "image" || x.modality === "audio"))
        .map((x) => ({ id: x.assetId || x.url, url: x.url, kind: x.modality as EditorAsset["kind"], label: x.category || "result", duration: null, category: x.category || undefined }));
      setLibrary(items);
    } catch { setLibrary([]); } finally { setBinLoading(false); }
  };
  const onUpload = async (files: FileList | null) => {
    if (!files?.length) return;
    setBinLoading(true);
    try {
      for (const file of Array.from(files)) {
        const fd = new FormData(); fd.append("file", file);
        const r = await fetch("/api/upload", { method: "POST", body: fd });
        const j = (await r.json()) as { id?: string; cdnUrl?: string; kind?: string };
        if (r.ok && j.cdnUrl && j.id) {
          const kind: EditorAsset["kind"] = j.kind === "video" || j.kind === "audio" ? j.kind : "image";
          setLibrary((p) => [{ id: j.id!, url: j.cdnUrl!, kind, label: file.name, duration: null }, ...p]);
        }
      }
    } catch { /* ignore */ } finally { setBinLoading(false); }
  };
  const visualLayers = layers.filter((l) => l.type !== "audio");
  const onLayer = (id: string) => clips.filter((c) => c.layer === id).sort((a, b) => a.start - b.start);
  const totalDur = Math.max(0.1, ...clips.map((c) => c.start + c.duration));
  const sel = clips.find((c) => c.id === selected) ?? null;
  const isActive = (c: EditClip, tt: number) => tt >= c.start && tt < c.start + c.duration;
  const endOf = (cl: EditClip[]) => Math.max(0.1, ...cl.map((c) => c.start + c.duration));

  const base = (kind: Kind, layer: string, url: string | undefined, label: string, start: number, duration: number, extra: Partial<EditClip> = {}): EditClip =>
    ({ id: uid(), layer, kind, url, label, start, duration, scale: 1, x: 0, y: 0, fadeIn: 0, fadeOut: 0, ...extra });
  const createLayerForType = (type: LayerType): string => {
    const id = `${type[0]}${Date.now()}_${_l++}`;
    setLayers((p) => { const idx = p.findIndex((l) => PRIO[l.type] > PRIO[type]); const at = idx === -1 ? p.length : idx; const n = [...p]; n.splice(at, 0, { id, type }); return n; });
    return id;
  };
  // route an added clip: into the selected layer (if compatible), else the first row of its type, else a new row
  const layerForKind = (type: LayerType): string => {
    if (selectedLayer) { const sl = layers.find((l) => l.id === selectedLayer); if (sl && sl.type === type) return sl.id; }
    const existing = layers.find((l) => l.type === type);
    return existing ? existing.id : createLayerForType(type);
  };
  const addAssetAt = (a: { kind: EditorAsset["kind"]; url: string; label: string; duration: number | null }, layerId?: string, start?: number) => {
    const known = a.duration != null && a.duration > 0;
    const duration = known ? (a.duration as number) : DEFAULTS[a.kind];
    let layer: string, at: number;
    if (layerId != null) { layer = layerId; at = Math.max(0, start ?? +playheadRef.current.toFixed(2)); }
    else if (a.kind === "video") {
      // videos build one continuous track by default — appended back-to-back on the first video layer
      layer = layers.find((l) => l.type === "video")?.id ?? createLayerForType("video");
      at = Math.max(0, ...clipsRef.current.filter((c) => c.layer === layer).map((c) => c.start + c.duration), 0);
    } else {
      at = Math.max(0, start ?? +playheadRef.current.toFixed(2));
      layer = layerWithRoom(clipLayerType(a.kind), at, duration);
    }
    setClips((p) => [...p, base(a.kind, layer, a.url, a.label, at, duration, known ? {} : { autoDur: true })]);
  };
  // when a video/audio's real duration loads, snap the clip length to it (unless already trimmed)
  const onMeta = (id: string, dur: number) => {
    if (!isFinite(dur) || dur <= 0) return;
    setClips((prev) => prev.map((c) => {
      if (c.id !== id) return c;
      const next = { ...c, srcDur: +dur.toFixed(2) }; // full media length — enables un-trimming
      if (c.autoDur) { next.duration = +dur.toFixed(2); next.autoDur = false; }
      return next;
    }));
  };
  // CapCut-style placement: drop at the playhead; if every layer of this type is
  // occupied there, create a new layer — otherwise reuse the first free one.
  const layerWithRoom = (type: LayerType, start: number, dur: number): string => {
    const overlaps = (lid: string) => clipsRef.current.some((c) => c.layer === lid && start < c.start + c.duration && start + dur > c.start);
    const candidates = layers.filter((l) => l.type === type);
    const free = candidates.find((l) => !overlaps(l.id));
    return free ? free.id : createLayerForType(type);
  };
  const addClipKind = (kind: Kind, extra: Partial<EditClip>, dur: number, label: string) => {
    const start = +playheadRef.current.toFixed(2);
    const id = layerWithRoom(clipLayerType(kind), start, dur);
    setClips((p) => [...p, base(kind, id, undefined, label, start, dur, extra)]);
  };
  const PLAIN_TEXT: TextStyle = { color: "#ffffff", shadow: true, plate: "none", enter: "", weight: 700 };
  // plain text layer by default — animations/styles are applied afterwards (Captions tab / Properties)
  const addText = (style?: TextStyle, label = "Text", text = "Your text") => addClipKind("text", { text, tstyle: { ...(style ?? PLAIN_TEXT) } }, DEFAULTS.text, label);
  // live style: update the template AND apply to selected captions (or all if none selected)
  const applyStyle = (next: TextStyle) => {
    setCapStyle(next);
    const sel = selectedRef.current.filter((id) => clipsRef.current.find((c) => c.id === id)?.kind === "text");
    const ids = sel.length ? new Set(sel) : null;
    setClips((prev) => prev.map((c) => (c.kind === "text" && (!ids || ids.has(c.id)) ? { ...c, tstyle: { ...next } } : c)));
  };
  // explicit buttons — restyle existing captions with the current style, no re-transcription
  const applyStyleAll = () => setClips((prev) => prev.map((c) => (c.kind === "text" ? { ...c, tstyle: { ...capStyle } } : c)));
  const applyStyleSelected = () => { const ids = new Set(selectedRef.current); setClips((prev) => prev.map((c) => (c.kind === "text" && ids.has(c.id) ? { ...c, tstyle: { ...capStyle } } : c))); };
  const savePreset = () => {
    const name = window.prompt("Preset name:");
    if (!name?.trim()) return;
    const next = [...savedPresets.filter((p) => p.name !== name.trim()), { name: name.trim(), style: { ...capStyle } }];
    setSavedPresets(next);
    try { localStorage.setItem("flowlab.capPresets", JSON.stringify(next)); } catch { /* ignore */ }
  };
  const deletePreset = (name: string) => {
    const next = savedPresets.filter((p) => p.name !== name);
    setSavedPresets(next);
    try { localStorage.setItem("flowlab.capPresets", JSON.stringify(next)); } catch { /* ignore */ }
  };
  const addFx = (type = "vignette") => addClipKind("fx", { fx: type }, DEFAULTS.fx, "FX");
  const addAdjust = (v = "grayscale(1)") => addClipKind("adjust", { fx: v }, DEFAULTS.adjust, "Adjust");

  // sources that have audio to transcribe
  const subSources = clips.filter((c) => (c.kind === "video" || c.kind === "audio") && c.url);
  const generateSubtitles = async () => {
    const src = subSources.find((c) => c.id === subSource) || subSources[0];
    if (!src?.url) { setSubStatus("Add a video or audio clip first."); return; }
    setSubBusy(true); setSubStatus("Submitting…");
    try {
      const sub = await fetch("/api/subtitles", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ audioUrl: src.url, language: "auto" }) });
      const sj = await sub.json();
      if (!sub.ok || !sj.id) throw new Error(sj.error || "submit failed");
      setSubStatus("Transcribing…");
      let words: Word[] | null = null;
      for (let i = 0; i < 240; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const pr = await fetch(`/api/subtitles?id=${sj.id}`);
        const pj = await pr.json();
        if (pj.status === "completed") { words = pj.words || []; break; }
        if (pj.status === "error") throw new Error(pj.error || "transcription error");
        setSubStatus(`Transcribing… ${i * 2}s`);
      }
      if (!words) throw new Error("Timed out");
      if (!words.length) throw new Error("No speech detected");
      const segs = groupWords(words, subMode);
      if (subEmoji) for (const sg of segs) { const e = emojiFor(sg.text); if (e) { const last = sg.words[sg.words.length - 1]; sg.text = `${sg.text} ${e}`; sg.words.push({ text: e, t: last ? +(last.t + last.d).toFixed(3) : 0, d: 0.01 }); } }
      const base0 = src.start; // align captions to where the source sits on the timeline
      // captions always go to a dedicated "Subtitles" text layer (created on top if missing)
      const subLayer = layers.find((l) => l.type === "text" && l.name === "Subtitles");
      let layerId: string;
      if (subLayer) layerId = subLayer.id;
      else { layerId = createLayerForType("text"); setLayers((p) => p.map((l) => (l.id === layerId ? { ...l, name: "Subtitles" } : l))); }
      setClips((p) => [...p, ...segs.map((sg) => base("text", layerId, undefined, "Caption", +(base0 + sg.start).toFixed(3), sg.dur, { text: sg.text, words: sg.words, tstyle: { ...capStyle } }))]);
      setSubStatus(`Done — ${segs.length} captions added.`);
    } catch (e) {
      setSubStatus(`Failed: ${e instanceof Error ? e.message : "error"}`);
    } finally { setSubBusy(false); }
  };
  const update = (id: string, patch: Partial<EditClip>) => setClips((p) => p.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  // for x/y/scale inspector fields: edit the whole selection when several clips are selected
  const updateSel = (id: string, patch: Partial<EditClip>) => {
    const ids = selectedRef.current.includes(id) && selectedRef.current.length > 1 ? new Set(selectedRef.current) : new Set([id]);
    setClips((p) => p.map((c) => (ids.has(c.id) ? { ...c, ...patch } : c)));
  };

  // Fetch the green-screen auto-track for any source referenced by a tracked clip.
  useEffect(() => {
    const urls = new Set<string>();
    for (const c of clips) {
      if (!c.trackTo) continue;
      const p = clips.find((x) => x.id === c.trackTo);
      if (p?.url && p.kind === "video") urls.add(p.url);
    }
    urls.forEach((url) => {
      if (trackCache[url]) return;
      setTrackCache((s) => ({ ...s, [url]: "loading" }));
      fetch("/api/screen-replace/track", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source: url }) })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error("track fetch failed"))))
        .then((j) => setTrackCache((s) => ({ ...s, [url]: { fps: j.fps || 30, w: j.w || 1080, h: j.h || 1920, quads: j.quads || [] } })))
        .catch(() => setTrackCache((s) => ({ ...s, [url]: "error" })));
    });
  }, [clips, trackCache]);
  const remove = useCallback((id: string) => { setClips((p) => p.filter((c) => c.id !== id)); setSelectedIds((s) => s.filter((x) => x !== id)); }, []);
  const removeMany = useCallback((ids: string[]) => { const set = new Set(ids); setClips((p) => p.filter((c) => !set.has(c.id))); setSelectedIds([]); }, []);
  // razor: split clips at the playhead (selected ones, or every clip under the playhead)
  const splitAtPlayhead = useCallback(() => {
    const t = playheadRef.current;
    const sel = selectedRef.current;
    setClips((prev) => {
      const targets = prev.filter((c) => t > c.start + 0.05 && t < c.start + c.duration - 0.05 && (sel.length ? sel.includes(c.id) : true));
      if (!targets.length) return prev;
      const out: EditClip[] = [];
      for (const c of prev) {
        if (!targets.includes(c)) { out.push(c); continue; }
        const cut = +(t - c.start).toFixed(3);
        const first: EditClip = { ...c, duration: cut };
        const second: EditClip = { ...c, id: uid(), start: +t.toFixed(3), duration: +(c.duration - cut).toFixed(3), inset: +((c.inset || 0) + cut).toFixed(3), fadeIn: 0 };
        first.fadeOut = 0;
        if (c.kind === "text" && c.words?.length) {
          const fw = c.words.filter((w) => w.t < cut);
          const sw = c.words.filter((w) => w.t >= cut).map((w) => ({ ...w, t: +(w.t - cut).toFixed(3) }));
          first.words = fw; first.text = fw.map((w) => w.text).join(" ") || c.text;
          second.words = sw; second.text = sw.map((w) => w.text).join(" ") || c.text;
        }
        out.push(first, second);
      }
      return out;
    });
  }, []);
  // duplicate selected clips onto a NEW layer (same type), keeping their time position
  const duplicateSelected = useCallback(() => {
    const sel = selectedRef.current; if (!sel.length) return;
    const src = clipsRef.current.filter((c) => sel.includes(c.id));
    if (!src.length) return;
    // one new layer per source layer, inserted right below the original
    const byLayer = new Map<string, EditClip[]>();
    for (const c of src) { const a = byLayer.get(c.layer) ?? []; a.push(c); byLayer.set(c.layer, a); }
    const layerMap = new Map<string, string>();
    setLayers((prev) => {
      const next = [...prev];
      for (const [lid] of byLayer) {
        const idx = next.findIndex((l) => l.id === lid);
        const type = next[idx]?.type ?? "video";
        const nid = `${type[0]}${Date.now()}_${_l++}`;
        next.splice(idx === -1 ? next.length : idx + 1, 0, { id: nid, type });
        layerMap.set(lid, nid);
      }
      return next;
    });
    setClips((prev) => {
      const copies: EditClip[] = [];
      for (const c of prev) if (sel.includes(c.id)) copies.push({ ...c, id: uid(), layer: layerMap.get(c.layer) ?? c.layer });
      return [...prev, ...copies];
    });
  }, []);
  const duplicate = (id: string) => setClips((p) => { const c = p.find((x) => x.id === id); return c ? [...p, { ...c, id: uid(), start: c.start + 0.3 }] : p; });
  const layerType = (c: { kind: Kind }): LayerType => clipLayerType(c.kind);
  const createLayerAt = (index: number, type: LayerType): string => {
    const id = `${type[0]}${Date.now()}_${_l++}`;
    setLayers((p) => { const n = [...p]; n.splice(Math.max(0, Math.min(index, n.length)), 0, { id, type }); return n; });
    return id;
  };
  // Section auto-layout: after a canvas hand-off with Hook/Body/Packshot/CTA,
  // place the sections back-to-back (section start = end of the previous one)
  // as soon as every sectioned media clip knows its real duration. Runs once
  // per import; manual edits afterwards are never overwritten.
  const sectionLayoutRef = useRef(false);
  useEffect(() => {
    if (!sectionLayoutRef.current) return;
    const sec = clips.filter((c) => c.section);
    if (!sec.length) { sectionLayoutRef.current = false; return; }
    if (sec.some((c) => c.autoDur)) return; // durations still loading
    sectionLayoutRef.current = false;
    const ORDER = ["Hook", "Body", "Packshot", "CTA"];
    const names = Array.from(new Set(sec.map((c) => c.section as string)))
      .sort((a, b) => (ORDER.indexOf(a) === -1 ? 99 : ORDER.indexOf(a)) - (ORDER.indexOf(b) === -1 ? 99 : ORDER.indexOf(b)));
    let cursor = 0;
    const startBy = new Map<string, number>();
    for (const name of names) {
      startBy.set(name, cursor);
      // a section lasts as long as its longest visual (video/image); audio/text ride along
      const span = Math.max(...sec.filter((c) => c.section === name && (c.kind === "video" || c.kind === "image")).map((c) => c.duration), 1);
      cursor = +(cursor + span).toFixed(2);
    }
    setClips((prev) => prev.map((c) => (c.section && startBy.has(c.section) ? { ...c, start: startBy.get(c.section) as number } : c)));
  }, [clips]);

  // auto-prune empty layers (keep ≥1 video + ≥1 audio baseline) — never while dragging.
  // The first (mount) run is skipped: it closes over the pre-restore empty clips
  // and would prune freshly restored/imported layers, piling clips onto one track.
  const pruneReadyRef = useRef(false);
  useEffect(() => {
    if (!pruneReadyRef.current) { pruneReadyRef.current = true; return; }
    if (dragRef.current) return;
    setLayers((prev) => {
      const used = new Set(clips.map((c) => c.layer));
      const kept = prev.filter((l) => used.has(l.id));
      if (!kept.some((l) => l.type === "video")) { const v = prev.find((l) => l.type === "video") ?? { id: `v${Date.now()}_${_l++}`, type: "video" as LayerType }; const ai = kept.findIndex((l) => l.type === "audio"); if (ai === -1) kept.push(v); else kept.splice(ai, 0, v); }
      if (!kept.some((l) => l.type === "audio")) { const a = prev.find((l) => l.type === "audio") ?? { id: `a${Date.now()}_${_l++}`, type: "audio" as LayerType }; kept.push(a); }
      const same = kept.length === prev.length && kept.every((l, i) => l.id === prev[i].id);
      return same ? prev : kept;
    });
  }, [clips]);
  // safety: a clip whose layer no longer exists is re-attached (never vanishes)
  useEffect(() => {
    const ids = new Set(layers.map((l) => l.id));
    if (!clips.some((c) => !ids.has(c.layer))) return;
    setClips((prev) => prev.map((c) => {
      if (ids.has(c.layer)) return c;
      const t = clipLayerType(c.kind);
      const fb = layers.find((l) => l.type === t) ?? layers.find((l) => l.type !== "audio") ?? layers[0];
      return fb ? { ...c, layer: fb.id } : c;
    }));
  }, [layers, clips]);
  const renameLayer = (id: string, value: string) => setLayers((p) => p.map((l) => (l.id === id ? { ...l, name: value.trim() || undefined } : l)));
  // display label: custom name, else type-prefixed number counted top→down
  const labelFor = (layer: Layer): string => {
    if (layer.name) return layer.name;
    const same = layers.filter((l) => l.type === layer.type);
    return `${TYPE_PREFIX[layer.type]}${same.indexOf(layer) + 1}`;
  };

  useEffect(() => {
    const c = containerRef.current; if (!c) return;
    const compute = () => {
      const cw = c.clientWidth, ch = c.clientHeight; if (cw < 2 || ch < 2) return;
      const ar = res.w / res.h; let w = cw, h = cw / ar; if (h > ch) { h = ch; w = ch * ar; }
      setPreviewSize({ w: Math.round(w), h: Math.round(h) });
    };
    compute(); const ro = new ResizeObserver(compute); ro.observe(c); return () => ro.disconnect();
  }, [res]);

  const layersRef = useRef<Layer[]>([]);
  layersRef.current = layers;
  const syncMedia = useCallback((tt: number) => {
    const hidden = new Set(layersRef.current.filter((l) => l.hidden).map((l) => l.id));
    for (const c of clipsRef.current) {
      const el = mediaRefs.current.get(c.id); if (!el) continue;
      const active = tt >= c.start && tt < c.start + c.duration && !hidden.has(c.layer);
      if (active) {
        const local = tt - c.start + (c.inset || 0);
        if (Math.abs(el.currentTime - local) > 0.3) { try { el.currentTime = local; } catch { /* */ } }
        try { el.volume = Math.max(0, Math.min(1, alphaAt(c, tt) * (c.muted ? 0 : (c.volume ?? 1)))); } catch { /* */ }
        if (playingRef.current && el.paused) el.play().catch(() => {});
        if (!playingRef.current && !el.paused) el.pause();
      } else {
        if (!el.paused) el.pause();
        // pre-seek soon-to-start clips to their in-point so the cut is seamless
        const ahead = c.start - tt;
        if (ahead > 0 && ahead < 2) {
          const want = c.inset || 0;
          if (Math.abs(el.currentTime - want) > 0.05) { try { el.currentTime = want; } catch { /* */ } }
        }
      }
    }
  }, []);
  const stop = useCallback(() => {
    playingRef.current = false; setPlaying(false);
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    for (const el of mediaRefs.current.values()) { try { el.pause(); } catch { /* */ } }
  }, []);
  const loop = useCallback((now: number) => {
    const dt = (now - lastTsRef.current) / 1000; lastTsRef.current = now;
    let tt = playheadRef.current + dt; const end = endOf(clipsRef.current);
    if (tt >= end) { tt = end; playheadRef.current = tt; setPlayhead(tt); syncMedia(tt); stop(); return; }
    playheadRef.current = tt; syncMedia(tt);
    // throttle React re-renders (~22fps); the <video> elements still play natively at full fps
    if (now - lastRenderRef.current > 45) { lastRenderRef.current = now; setPlayhead(tt); }
    if (playingRef.current) rafRef.current = requestAnimationFrame(loop);
  }, [syncMedia, stop]);
  const play = useCallback(() => {
    if (playingRef.current) { stop(); return; }
    if (!clipsRef.current.length) return;
    if (playheadRef.current >= endOf(clipsRef.current)) { playheadRef.current = 0; setPlayhead(0); }
    playingRef.current = true; setPlaying(true); lastTsRef.current = performance.now();
    syncMedia(playheadRef.current); rafRef.current = requestAnimationFrame(loop);
  }, [loop, stop, syncMedia]);
  const seek = useCallback((sec: number) => { const tt = Math.max(0, sec); playheadRef.current = tt; setPlayhead(tt); syncMedia(tt); }, [syncMedia]);
  useEffect(() => () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tg = e.target as HTMLElement | null;
      if (tg && (tg.tagName === "INPUT" || tg.tagName === "TEXTAREA" || tg.tagName === "SELECT" || tg.isContentEditable)) return;
      if (e.code === "Space") { e.preventDefault(); play(); }
      else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
      else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "y") { e.preventDefault(); redo(); }
      else if ((e.metaKey || e.ctrlKey) && e.code === "KeyD") { e.preventDefault(); duplicateSelected(); }
      else if ((e.metaKey || e.ctrlKey) && e.code === "KeyB") { e.preventDefault(); splitAtPlayhead(); }
      else if (!e.metaKey && !e.ctrlKey && e.code === "KeyS") { e.preventDefault(); splitAtPlayhead(); }
      else if (e.key === "Delete" || e.key === "Backspace") { if (selectedRef.current.length) { e.preventDefault(); removeMany(selectedRef.current); } }
    };
    window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey);
  }, [play, removeMany, undo, redo, duplicateSelected, splitAtPlayhead]);

  useEffect(() => {
    if (!menu && !transMenu) return;
    const close = () => { setMenu(null); setTransMenu(null); };
    window.addEventListener("click", close); window.addEventListener("scroll", close, true); window.addEventListener("resize", close);
    return () => { window.removeEventListener("click", close); window.removeEventListener("scroll", close, true); window.removeEventListener("resize", close); };
  }, [menu, transMenu]);

  const exportMp4 = useCallback(async () => {
    if (exporting || !clips.length) return;
    setExporting(true); setProgress(0); setStatus("Recording…"); stop();
    try {
      const vis = layers.filter((l) => l.type !== "audio");
      const hiddenIds = new Set(layers.filter((l) => l.hidden).map((l) => l.id));
      const z: EditClip[] = [];
      for (let i = vis.length - 1; i >= 0; i--) { if (hiddenIds.has(vis[i].id)) continue; z.push(...clips.filter((c) => c.layer === vis[i].id).sort((a, b) => a.start - b.start)); }
      const ordered = [...z, ...clips.filter((c) => !z.includes(c) && !hiddenIds.has(c.layer))];
      const { exportTimeline } = await import("@/lib/editor/exportVideo");
      const { blob, ext, mp4 } = await exportTimeline({
        clips: ordered.map((c) => ({ id: c.id, layer: c.layer, kind: c.kind, url: c.url, text: c.text, start: c.start, duration: c.duration, scale: c.scale, x: c.x, y: c.y, fadeIn: c.fadeIn, fadeOut: c.fadeOut, anim: c.anim, fx: c.fx, transType: c.transType, inset: c.inset, volume: c.volume, muted: c.muted, blend: c.blend, keyColor: c.keyColor, keyTol: c.keyTol, tstyle: c.tstyle, words: c.words, trackTo: c.trackTo, trackKeys: c.trackKeys, trackMode: c.trackMode })),
        width: res.w, height: res.h, previewWidth: previewSize.w,
        onProgress: (p) => setProgress(Math.round(p * 100)),
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url; a.download = `flowlab-${Date.now()}.${ext}`;
      document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
      setStatus(mp4 ? "Done — MP4 downloaded." : "Done — WebM downloaded (browser doesn\u2019t support MP4 recording).");
    } catch (e) { console.error(e); setStatus(`Export failed: ${e instanceof Error ? e.message : "see console"}`); }
    finally { setExporting(false); }
  }, [exporting, clips, layers, res, previewSize, stop]);

  // Reverse bridge: render + upload + hand the URL to the canvas Editor node
  const [sendingToCanvas, setSendingToCanvas] = useState(false);
  const exportToCanvas = useCallback(async () => {
    if (!workflowId || sendingToCanvas || exporting || !clips.length) return;
    setSendingToCanvas(true); setProgress(0); setStatus("Rendering for canvas…"); stop();
    try {
      const vis = layers.filter((l) => l.type !== "audio");
      const hiddenIds = new Set(layers.filter((l) => l.hidden).map((l) => l.id));
      const z: EditClip[] = [];
      for (let i = vis.length - 1; i >= 0; i--) { if (hiddenIds.has(vis[i].id)) continue; z.push(...clips.filter((c) => c.layer === vis[i].id).sort((a, b) => a.start - b.start)); }
      const ordered = [...z, ...clips.filter((c) => !z.includes(c) && !hiddenIds.has(c.layer))];
      const { exportTimeline } = await import("@/lib/editor/exportVideo");
      const { blob, ext } = await exportTimeline({
        clips: ordered.map((c) => ({ id: c.id, layer: c.layer, kind: c.kind, url: c.url, text: c.text, start: c.start, duration: c.duration, scale: c.scale, x: c.x, y: c.y, fadeIn: c.fadeIn, fadeOut: c.fadeOut, anim: c.anim, fx: c.fx, transType: c.transType, inset: c.inset, volume: c.volume, muted: c.muted, blend: c.blend, keyColor: c.keyColor, keyTol: c.keyTol, tstyle: c.tstyle, words: c.words, trackTo: c.trackTo, trackKeys: c.trackKeys, trackMode: c.trackMode })),
        width: res.w, height: res.h, previewWidth: previewSize.w,
        onProgress: (p) => setProgress(Math.round(p * 100)),
      });
      setStatus("Uploading…");
      const fd = new FormData();
      fd.append("file", new File([blob], `editor-export-${Date.now()}.${ext}`, { type: blob.type || "video/mp4" }));
      const r = await fetch("/api/upload", { method: "POST", body: fd });
      const j = (await r.json()) as { cdnUrl?: string; error?: string };
      if (!r.ok || !j.cdnUrl) throw new Error(j.error || "upload failed");
      localStorage.setItem(`flowlab.editor.export.v1:${workflowId}`, JSON.stringify({ url: j.cdnUrl, at: Date.now() }));
      setStatus("Sent to canvas ✓ — the Editor node now outputs this video.");
    } catch (e) { console.error(e); setStatus(`Send failed: ${e instanceof Error ? e.message : "see console"}`); }
    finally { setSendingToCanvas(false); }
  }, [workflowId, sendingToCanvas, exporting, clips, layers, res, previewSize, stop]);

  const dragRef = useRef<{ id: string; mode: "move" | "trim" | "trimL"; startX: number; origDur: number; origStart: number; origInset: number; type: LayerType; moveIds: string[]; origStarts: Map<string, number> } | null>(null);
  const hitTest = (clientY: number, type: LayerType): { type: "lane" | "strip"; id: string } | null => {
    for (const [id, el] of stripRefs.current) { const r = el.getBoundingClientRect(); if (clientY >= r.top - 3 && clientY <= r.bottom + 3) return { type: "strip", id }; }
    for (const [id, el] of laneRefs.current) { const r = el.getBoundingClientRect(); if (clientY >= r.top && clientY <= r.bottom) { const lane = layers.find((l) => l.id === id); return lane && lane.type === type ? { type: "lane", id } : null; } }
    return null;
  };
  const isLocked = (c: EditClip) => !!layersRef.current.find((l) => l.id === c.layer)?.locked;
  const onClipPointerDown = (e: React.PointerEvent, c: EditClip, mode: "move" | "trim" | "trimL") => {
    e.stopPropagation();
    if (isLocked(c)) return; (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
    const ids = additive ? (selectedRef.current.includes(c.id) ? selectedRef.current.filter((x) => x !== c.id) : [...selectedRef.current, c.id]) : (selectedRef.current.includes(c.id) ? selectedRef.current : [c.id]);
    setSelectedIds(ids);
    const moveIds = mode === "move" ? (ids.length ? ids : [c.id]) : [c.id];
    const origStarts = new Map(moveIds.map((id) => [id, clipsRef.current.find((x) => x.id === id)?.start ?? 0]));
    dragRef.current = { id: c.id, mode, startX: e.clientX, origDur: c.duration, origStart: c.start, origInset: c.inset || 0, type: layerType(c), moveIds, origStarts };
  };
  const onClipPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current; if (!d) return; const dx = (e.clientX - d.startX) / pxPerSec;
    if (d.mode === "move") {
      setClips((prev) => prev.map((x) => (d.moveIds.includes(x.id) ? { ...x, start: Math.max(0, +((d.origStarts.get(x.id) ?? x.start) + dx).toFixed(2)) } : x)));
      setDropHint(d.moveIds.length > 1 ? null : hitTest(e.clientY, d.type)); // layer change only for a single clip
    } else if (d.mode === "trim") {
      const c = clipsRef.current.find((x) => x.id === d.id);
      const isMedia = c && (c.kind === "video" || c.kind === "audio");
      const maxDur = isMedia && c?.srcDur ? Math.max(MIN_DUR, c.srcDur - (c.inset || 0)) : Infinity; // drag right again to restore up to the source length
      update(d.id, { duration: Math.max(MIN_DUR, Math.min(maxDur, +(d.origDur + dx).toFixed(2))) });
    } else if (d.mode === "trimL") {
      const c = clipsRef.current.find((x) => x.id === d.id);
      const isMedia = c && (c.kind === "video" || c.kind === "audio");
      // left edge: dragging right trims; dragging left restores hidden head (down to inset 0)
      const minDx = Math.max(isMedia ? -d.origInset : -Infinity, -d.origStart);
      const maxDx = d.origDur - MIN_DUR;
      const ddx = Math.max(minDx, Math.min(maxDx, dx));
      update(d.id, {
        start: +(d.origStart + ddx).toFixed(2),
        duration: +(d.origDur - ddx).toFixed(2),
        ...(isMedia ? { inset: +(d.origInset + ddx).toFixed(3) } : {}),
      });
    }
  };
  const onClipPointerUp = () => {
    const d = dragRef.current; dragRef.current = null;
    const hint = dropHintRef.current; setDropHint(null);
    if (!d || d.mode !== "move" || !hint || d.moveIds.length > 1) return;
    const clip = clipsRef.current.find((c) => c.id === d.id); if (!clip) return;
    if (hint.type === "lane") { if (hint.id !== clip.layer) update(d.id, { layer: hint.id }); }
    else { const index = Number(hint.id.split("-")[1]); const id = createLayerAt(index, d.type); update(d.id, { layer: id }); }
  };

  const onMarqueeDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const el = e.target as HTMLElement;
    if (el.closest("[data-clip],[data-ruler],[data-label]")) return; // only on empty background
    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
    marqueeRef.current = { x0: e.clientX, y0: e.clientY };
    const baseSel = additive ? [...selectedRef.current] : [];
    if (!additive) setSelectedIds([]);
    const compute = (ev: PointerEvent) => {
      const m = marqueeRef.current; if (!m) return;
      const x0 = Math.min(ev.clientX, m.x0), x1 = Math.max(ev.clientX, m.x0);
      const y0 = Math.min(ev.clientY, m.y0), y1 = Math.max(ev.clientY, m.y0);
      const hits: string[] = [];
      for (const c of clipsRef.current) {
        const laneEl = laneRefs.current.get(c.layer); if (!laneEl) continue;
        const lr = laneEl.getBoundingClientRect();
        const cx0 = lr.left + c.start * pxPerSec, cx1 = lr.left + (c.start + c.duration) * pxPerSec;
        if (cx1 >= x0 && cx0 <= x1 && lr.bottom >= y0 && lr.top <= y1) hits.push(c.id);
      }
      return { x0, y0, x1, y1, hits };
    };
    const move = (ev: PointerEvent) => {
      const r = compute(ev); if (!r) return;
      setMarquee({ x: r.x0, y: r.y0, w: r.x1 - r.x0, h: r.y1 - r.y0 });
      setSelectedIds(additive ? Array.from(new Set([...baseSel, ...r.hits])) : r.hits);
    };
    const up = (ev: PointerEvent) => {
      const r = compute(ev); if (r) setSelectedIds(additive ? Array.from(new Set([...baseSel, ...r.hits])) : r.hits);
      marqueeRef.current = null; setMarquee(null);
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  };
  const scrubRef = useRef(false);
  const seekFromRuler = (clientX: number, el: HTMLElement) => { const r = el.getBoundingClientRect(); seek((clientX - r.left) / pxPerSec); };
  const onRulerDown = (e: React.PointerEvent) => { scrubRef.current = true; (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId); if (playingRef.current) stop(); seekFromRuler(e.clientX, e.currentTarget as HTMLElement); };
  const onRulerMove = (e: React.PointerEvent) => { if (scrubRef.current) seekFromRuler(e.clientX, e.currentTarget as HTMLElement); };
  const onRulerUp = () => { scrubRef.current = false; };

  const [viewZoom, setViewZoom] = useState(1);
  const [viewPan, setViewPan] = useState({ x: 0, y: 0 });
  const [snap, setSnap] = useState<{ v: boolean; h: boolean }>({ v: false, h: false });
  const viewZoomRef = useRef(1); viewZoomRef.current = viewZoom;
  const fitView = () => { setViewZoom(1); setViewPan({ x: 0, y: 0 }); };
  const onViewWheel = (e: React.WheelEvent) => {
    if (!clips.length) return; e.preventDefault();
    const el = containerRef.current; if (!el) return;
    const rect = el.getBoundingClientRect();
    const cx = e.clientX - (rect.left + rect.width / 2);
    const cy = e.clientY - (rect.top + rect.height / 2);
    const z = viewZoomRef.current || 1;
    const f = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    const nz = Math.min(8, Math.max(0.1, +(z * f).toFixed(3)));
    const ratio = nz / z;
    setViewPan((p) => ({ x: cx - (cx - p.x) * ratio, y: cy - (cy - p.y) * ratio }));
    setViewZoom(nz);
  };
  const onPanDown = (e: React.PointerEvent) => {
    if (e.button !== 0 && e.button !== 1) return;
    if (e.button === 0) setSelectedIds([]);
    const s = { x: e.clientX, y: e.clientY, ox: viewPan.x, oy: viewPan.y };
    const move = (ev: PointerEvent) => setViewPan({ x: s.ox + (ev.clientX - s.x), y: s.oy + (ev.clientY - s.y) });
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  };
  const onVpDown = (e: React.PointerEvent, c: EditClip, mode: "move" | "scale") => {
    if (e.button === 1) return; // middle button → let the viewport pan
    e.stopPropagation();
    if (isLocked(c)) return;
    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
    const ids = additive ? (selectedRef.current.includes(c.id) ? selectedRef.current.filter((x) => x !== c.id) : [...selectedRef.current, c.id]) : (selectedRef.current.includes(c.id) ? selectedRef.current : [c.id]);
    setSelectedIds(ids);
    const TH = 10; const STEPS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3];
    const groupIds = mode === "move" ? (ids.length ? ids : [c.id]) : [c.id];
    const orig = new Map(groupIds.map((id) => { const cc = clipsRef.current.find((x) => x.id === id); return [id, { x: cc?.x ?? 0, y: cc?.y ?? 0 }]; }));
    const s = { sx: e.clientX, sy: e.clientY, ox: c.x, oy: c.y, os: c.scale };
    const move = (ev: PointerEvent) => {
      const z = viewZoomRef.current || 1; const dxr = (ev.clientX - s.sx) / z, dyr = (ev.clientY - s.sy) / z;
      if (mode === "move") {
        // snap based on the grabbed clip, apply the same (snapped) delta to the whole selection
        let nx = s.ox + dxr, ny = s.oy + dyr;
        const v = Math.abs(nx) < TH; if (v) nx = 0;
        const h = Math.abs(ny) < TH; if (h) ny = 0;
        setSnap({ v, h });
        const ddx = nx - s.ox, ddy = ny - s.oy;
        setClips((prev) => prev.map((x) => { const o = orig.get(x.id); return o ? { ...x, x: Math.round(o.x + ddx), y: Math.round(o.y + ddy) } : x; }));
      } else {
        let ns = +(s.os + (dxr + dyr) / 250).toFixed(2);
        const hit = STEPS.find((st) => Math.abs(ns - st) < 0.05); if (hit) ns = hit;
        update(c.id, { scale: Math.min(8, Math.max(0.05, ns)) });
      }
    };
    const up = () => { setSnap({ v: false, h: false }); window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  };
  const resetTransform = (id: string) => update(id, { x: 0, y: 0, scale: 1 });
  // drag a caption box on the canvas overlay → move (x/y); corner handle → scale
  const onCapDown = (e: React.PointerEvent, c: EditClip) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    if (isLocked(c)) return;
    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
    const ids = additive ? (selectedRef.current.includes(c.id) ? selectedRef.current.filter((x) => x !== c.id) : [...selectedRef.current, c.id]) : (selectedRef.current.includes(c.id) ? selectedRef.current : [c.id]);
    setSelectedIds(ids);
    // group move: same delta to every selected text clip
    const group = (ids.length ? ids : [c.id]).filter((id) => clipsRef.current.find((x) => x.id === id)?.kind === "text");
    const orig = new Map(group.map((id) => { const cc = clipsRef.current.find((x) => x.id === id)!; return [id, { x: cc.x, y: cc.y }]; }));
    const s = { sx: e.clientX, sy: e.clientY };
    const move = (ev: PointerEvent) => {
      const z = viewZoomRef.current || 1;
      const dx = (ev.clientX - s.sx) / z, dy = (ev.clientY - s.sy) / z;
      setClips((prev) => prev.map((x) => { const o = orig.get(x.id); return o ? { ...x, x: Math.round(o.x + dx), y: Math.round(o.y + dy) } : x; }));
    };
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  };
  const onCapScale = (e: React.PointerEvent, c: EditClip) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    if (isLocked(c)) return;
    // group scale: same delta applied to each selected caption's own scale
    const group = (selectedRef.current.includes(c.id) ? selectedRef.current : [c.id]).filter((id) => clipsRef.current.find((x) => x.id === id)?.kind === "text");
    const orig = new Map(group.map((id) => [id, clipsRef.current.find((x) => x.id === id)!.scale]));
    const s = { sx: e.clientX, sy: e.clientY };
    const move = (ev: PointerEvent) => {
      const z = viewZoomRef.current || 1;
      const d = ((ev.clientX - s.sx) + (ev.clientY - s.sy)) / z / 250;
      setClips((prev) => prev.map((x) => { const o = orig.get(x.id); return o != null ? { ...x, scale: Math.min(8, Math.max(0.2, +(o + d).toFixed(2))) } : x; }));
    };
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  };

  const onBinDragStart = (e: React.DragEvent, a: EditorAsset) => {
    e.dataTransfer.setData("application/x-flowlab-asset", JSON.stringify({ kind: a.kind, url: a.url, label: a.label, duration: a.duration }));
    e.dataTransfer.effectAllowed = "copy";
  };
  const onLaneDrop = (e: React.DragEvent, layer: Layer) => {
    e.preventDefault(); setDropHint(null);
    const raw = e.dataTransfer.getData("application/x-flowlab-asset"); if (!raw) return;
    const a = JSON.parse(raw) as { kind: EditorAsset["kind"]; url: string; label: string; duration: number | null };
    if (clipLayerType(a.kind) !== layer.type) return;
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    addAssetAt(a, layer.id, Math.max(0, (e.clientX - r.left) / pxPerSec));
  };
  const onStripDrop = (e: React.DragEvent, index: number) => {
    e.preventDefault(); setDropHint(null);
    const raw = e.dataTransfer.getData("application/x-flowlab-asset"); if (!raw) return;
    const a = JSON.parse(raw) as { kind: EditorAsset["kind"]; url: string; label: string; duration: number | null };
    const id = createLayerAt(index, clipLayerType(a.kind));
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    addAssetAt(a, id, Math.max(0, (e.clientX - r.left) / pxPerSec));
  };

  const onClipContext = (e: React.MouseEvent, c: EditClip) => { e.preventDefault(); e.stopPropagation(); if (!selectedRef.current.includes(c.id)) setSelectedIds([c.id]); setMenu({ x: e.clientX, y: e.clientY, id: c.id }); };

  // transition applied via the "+" between two adjacent clips (CapCut-style)
  const applyTransition = (bId: string, v: string) => {
    const b = clipsRef.current.find((c) => c.id === bId); if (!b) return;
    const prev = clipsRef.current.filter((c) => c.layer === b.layer && (c.kind === "video" || c.kind === "image" || c.kind === "text") && c.start < b.start).sort((p, q) => q.start - p.start)[0];
    const patch: Partial<EditClip> = { transType: v };
    if (v && prev) { const ns = +(prev.start + prev.duration - 0.5).toFixed(2); if (ns >= 0 && ns < b.start) patch.start = ns; }
    update(bId, patch); setTransMenu(null);
  };

  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  const [previewingUrl, setPreviewingUrl] = useState<string | null>(null);
  const togglePreview = (url: string) => {
    const cur = previewAudioRef.current;
    if (previewingUrl === url && cur) { cur.pause(); setPreviewingUrl(null); return; }
    if (cur) cur.pause();
    const a = new Audio(url); a.volume = 0.9; a.onended = () => setPreviewingUrl(null);
    previewAudioRef.current = a; setPreviewingUrl(url);
    a.play().catch(() => setPreviewingUrl(null));
  };
  useEffect(() => () => { previewAudioRef.current?.pause(); }, []);
  const assetGrid = (items: EditorAsset[]) => (
    <div className="flex-1 min-h-0 overflow-y-auto p-2">
      <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(96px, 1fr))` }}>
        {items.map((a) => (
          <div key={a.id} className="min-w-0">
            <div role="button" tabIndex={0} draggable onDragStart={(e) => onBinDragStart(e, a)} onClick={() => addAssetAt(a)} title={`${a.label}${extOf(a.url) ? ` · ${extOf(a.url)}` : ""}`}
              onMouseEnter={(e) => { const v = e.currentTarget.querySelector("video"); if (v) (v as HTMLVideoElement).play().catch(() => {}); }}
              onMouseLeave={(e) => { const v = e.currentTarget.querySelector("video"); if (v) { (v as HTMLVideoElement).pause(); (v as HTMLVideoElement).currentTime = 0; } }}
              className="group relative w-full aspect-square rounded-md overflow-hidden bg-bg-card border border-border hover:border-brand cursor-grab active:cursor-grabbing">
              {a.kind === "image" ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={a.url} alt="" onLoad={(e) => noteDims(a.url, e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)} className="absolute inset-0 w-full h-full object-cover" loading="lazy" draggable={false} />
              ) : a.kind === "video" ? (
                <video src={a.url} muted loop playsInline preload="metadata" onLoadedMetadata={(e) => noteDims(a.url, e.currentTarget.videoWidth, e.currentTarget.videoHeight)}
                  className="absolute inset-0 w-full h-full object-cover pointer-events-none" />
              ) : (
                <span className="absolute inset-0 flex items-center justify-center text-fg-subtle"><Music size={20} />
                  <button onClick={(e) => { e.stopPropagation(); togglePreview(a.url); }} title={previewingUrl === a.url ? "Stop" : "Preview"}
                    className="absolute bottom-1 right-1 w-6 h-6 grid place-items-center rounded-full bg-black/70 text-white hover:bg-black/90">
                    {previewingUrl === a.url ? <Pause size={11} /> : <Play size={11} />}
                  </button>
                </span>
              )}
              <span className="absolute top-1 left-1 px-1 rounded bg-black/60 text-[8px] uppercase text-white/80">{a.kind}</span>
              {extOf(a.url) && <span className="absolute bottom-1 left-1 px-1 rounded bg-black/60 text-[8px] text-white/70">{extOf(a.url)}</span>}
              {a.subpath && <span className="absolute top-1 right-1 px-1 rounded bg-black/60 text-[8px] text-white/80">{a.subpath.split("/")[0]}</span>}
              {a.duration != null && a.duration > 0 && <span className="absolute bottom-1 right-1 px-1 rounded bg-black/60 text-[8px] text-white/70">{Math.round(a.duration)}s</span>}
              {dims[a.url] && <span className="absolute bottom-1 left-1/2 -translate-x-1/2 px-1 rounded bg-black/60 text-[8px] text-white/70 whitespace-nowrap">{dims[a.url]}</span>}
              <span className="absolute inset-0 flex items-center justify-center bg-black/0 group-hover:bg-black/40 opacity-0 group-hover:opacity-100 pointer-events-none"><Plus size={18} className="text-white" /></span>
            </div>
            <div className="mt-0.5 text-[9px] text-fg-subtle truncate" title={a.label}>{a.label}</div>
          </div>
        ))}
        {items.length === 0 && <div className="col-span-full text-fg-subtle text-[11px] p-3">{binLoading ? "Loading…" : "Nothing here yet."}</div>}
      </div>
    </div>
  );

  const t = playhead;
  const styleFromVisual = (c: EditClip, v: ReturnType<typeof clipVisual>): React.CSSProperties => {
    const tx = (c.x || 0) + v.offX * previewSize.w;
    const ty = (c.y || 0) + v.offY * previewSize.h;
    return {
      opacity: v.opacity,
      transform: `translate(${tx}px, ${ty}px) scale(${(c.scale || 1) * v.scaleMul})`,
      transformOrigin: "center",
      clipPath: v.reveal != null ? `inset(0 ${Math.round((1 - v.reveal) * 100)}% 0 0)` : undefined,
    };
  };
  // Live corner-pin warp for a clip tracked onto a green-screen phone screen.
  // Maps the clip's full preview rect onto the corrected screen quad at the
  // current frame. Returns null when not tracked / track not loaded yet.
  // NOTE: assumes the green-screen clip fills the frame at the project aspect.
  const warpStyle = (c: EditClip, opacity: number, tt: number): React.CSSProperties | null => {
    if (!c.trackTo || !previewSize.w) return null;
    const phone = clips.find((x) => x.id === c.trackTo);
    const trk = phone?.url ? trackCache[phone.url] : null;
    if (!phone || !trk || typeof trk === "string") return null;
    const N = trk.quads.length;
    if (N < 1) return null;
    const vt = (tt - (phone.start || 0)) + (phone.inset || 0);
    const frame = Math.max(0, Math.min(N - 1, Math.round(vt * trk.fps)));
    const quad = correctedQuadAt(trk.quads, c.trackKeys || [], frame, c.trackMode || "anchor");
    const sx = previewSize.w / (trk.w || previewSize.w), sy = previewSize.h / (trk.h || previewSize.h);
    const qp = quad.map((p) => [p[0] * sx, p[1] * sy]);
    const m = cornerPinMatrix3d(previewSize.w, previewSize.h, qp);
    return { transform: `matrix3d(${m.join(",")})`, transformOrigin: "0 0", opacity };
  };
  const fxStyle = (kind?: string): React.CSSProperties =>
    kind === "flash" ? { background: "#fff" }
    : kind === "fadeBlack" ? { background: "#000" }
    : kind === "tint" ? { background: "rgba(255,120,40,0.25)" }
    : kind === "coolTint" ? { background: "rgba(40,120,255,0.22)" }
    : kind === "blackbars" ? { background: "linear-gradient(to bottom, #000 0, #000 12%, transparent 12%, transparent 88%, #000 88%, #000 100%)" }
    : kind === "glow" ? { background: "radial-gradient(ellipse at center, rgba(255,255,255,0.28) 0%, rgba(255,255,255,0) 60%)" }
    : kind === "dark" ? { background: "rgba(0,0,0,0.4)" }
    : kind === "topShade" ? { background: "linear-gradient(to bottom, rgba(0,0,0,0.7) 0%, rgba(0,0,0,0) 40%)" }
    : kind === "bottomShade" ? { background: "linear-gradient(to top, rgba(0,0,0,0.7) 0%, rgba(0,0,0,0) 40%)" }
    : { background: "radial-gradient(ellipse at center, rgba(0,0,0,0) 40%, rgba(0,0,0,0.78) 100%)" };

  // z-order (bottom → top) of all visual-layer clips
  const zClips: EditClip[] = [];
  for (let i = visualLayers.length - 1; i >= 0; i--) { if (visualLayers[i].hidden) continue; zClips.push(...onLayer(visualLayers[i].id)); }

  return (
    <div className="flex-1 flex min-h-0">
      {/* Left rail (CapCut-style) */}
      <nav className="w-12 shrink-0 border-r border-border flex flex-col items-center py-2 gap-1 text-fg-subtle">
        {([
          ["media", "Media", <Clapperboard key="i" size={16} />],
          ["brand", "Assets", <Folder key="i" size={16} />],
          ["audio", "Audio", <Music key="i" size={16} />],
          ["text", "Text", <Type key="i" size={16} />],
          ["subs", "Captions", <Subtitles key="i" size={16} />],
          ["effects", "Effects", <Wand2 key="i" size={16} />],
          ["filters", "Filters", <SlidersHorizontal key="i" size={16} />],
        ] as const).map(([k, l, icon]) => (
          <button key={k} onClick={() => { setRailTab(k); if (leftW === 0) setLeftW(260); }} title={l}
            className={`w-10 py-1.5 rounded flex flex-col items-center gap-0.5 ${railTab === k && leftW !== 0 ? "bg-brand/15 text-brand" : "hover:text-fg"}`}>
            {icon}
            <span className="text-[8px] leading-none">{l}</span>
          </button>
        ))}
      </nav>

      {/* Left panel — content of the selected rail tab */}
      {leftW === 0 && (
        <button onClick={() => setLeftW(260)} title="Show panel" className="shrink-0 w-5 border-r border-border text-fg-subtle hover:text-fg text-[10px]">›</button>
      )}
      <aside style={{ width: leftW, display: leftW === 0 ? "none" : undefined }} className="relative shrink-0 border-r border-border flex flex-col min-h-0">
        <div className="h-11 shrink-0 border-b border-border flex items-center justify-between px-3 text-[12px] font-medium text-fg">
          {railTab === "media" ? "Media" : railTab === "brand" ? "Brand assets" : railTab === "audio" ? "Audio" : railTab === "text" ? "Text" : railTab === "subs" ? "Captions" : railTab === "effects" ? "Effects" : "Filters"}
          <button onClick={() => setLeftW(0)} title="Hide panel" className="text-fg-subtle hover:text-fg">‹</button>
        </div>
        <div onPointerDown={dragPanel("left")} className="absolute top-0 -right-1 w-2 h-full cursor-col-resize z-20" title="Drag to resize" />

        {railTab === "media" && (<>
          <div className="shrink-0 border-b border-border/50 p-2 space-y-1.5">
            <div className="flex gap-1.5">
              <button onClick={() => fileInputRef.current?.click()} className="flex-1 inline-flex items-center justify-center gap-1 py-1.5 rounded border border-border text-fg-muted hover:text-fg hover:border-brand text-[11px]"><Plus size={12} /> Upload</button>
              <button onClick={() => loadGen()} disabled={binLoading} className="px-2 rounded border border-border text-fg-muted hover:text-fg text-[11px] disabled:opacity-50">{binLoading ? "…" : "Refresh"}</button>
            </div>
            <input ref={fileInputRef} type="file" accept="video/*,image/*,audio/*" multiple className="hidden" onChange={(e) => { onUpload(e.target.files); e.target.value = ""; }} />
            <input value={binQuery} onChange={(e) => setBinQuery(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") runSearch(); }} placeholder="Semantic search… (Enter)" className="w-full bg-bg-card border border-border rounded px-2 py-1.5 text-[11px] text-fg outline-none focus:border-brand" />
            {brands.length > 0 && (
              <select value={binBrand} onChange={(e) => { const b = e.target.value; setBinBrand(b); setBinProject(""); loadGen({ brand: b, project: "" }); loadBrand(b); }} className="w-full bg-bg-card border border-border rounded px-1.5 py-1.5 text-[11px] text-fg outline-none">
                <option value="">All brands</option>
                {brands.map((b) => <option key={b.value} value={b.value}>{b.label}</option>)}
              </select>
            )}
            <div className="grid grid-cols-2 gap-1.5">
              {projects.length > 0 && (
                <select value={binProject} onChange={(e) => { setBinProject(e.target.value); loadGen({ project: e.target.value }); }} className="bg-bg-card border border-border rounded px-1.5 py-1.5 text-[11px] text-fg outline-none">
                  <option value="">All projects</option>
                  {projects.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                </select>
              )}
              <select value={binSource} onChange={(e) => { setBinSource(e.target.value); loadGen({ source: e.target.value }); }} className="bg-bg-card border border-border rounded px-1.5 py-1.5 text-[11px] text-fg outline-none">
                <option value="">All sources</option>
                <option value="upload">Uploads</option>
                <option value="generated">Generated</option>
              </select>
            </div>
            <div className="flex items-center gap-1 text-[10px]">
              {(["all", "video", "image", "audio"] as const).map((f) => (
                <button key={f} onClick={() => setBinFilter(f)} className={`px-2 py-0.5 rounded ${binFilter === f ? "bg-brand/15 text-brand" : "text-fg-subtle hover:text-fg"}`}>{f}</button>
              ))}
              <div className="ml-auto flex items-center gap-1">
                <select value={binAspect} onChange={(e) => setBinAspect(e.target.value)} title="Aspect ratio" className="bg-bg-card border border-border rounded px-1 py-0.5 text-fg-muted outline-none">
                  <option value="all">ratio</option><option value="1:1">1:1</option><option value="4:5">4:5</option><option value="9:16">9:16</option><option value="16:9">16:9</option><option value="3:4">3:4</option><option value="2:3">2:3</option><option value="Portrait">portrait</option><option value="Landscape">landscape</option>
                </select>
                <select value={binSort} onChange={(e) => setBinSort(e.target.value as typeof binSort)} className="bg-bg-card border border-border rounded px-1 py-0.5 text-fg-muted outline-none">
                  <option value="newest">Newest</option><option value="oldest">Oldest</option><option value="az">Name A–Z</option><option value="za">Name Z–A</option><option value="kind">Type</option><option value="duration">Duration</option>
                </select>
              </div>
            </div>
          </div>
          {assetGrid(mediaBin)}
        </>)}

        {railTab === "brand" && (<>
          <div className="shrink-0 border-b border-border/50 p-2 space-y-1.5">
            <div className="flex gap-1.5">
              <select value={binBrand} onChange={(e) => { setBinBrand(e.target.value); loadBrand(e.target.value); }} className="flex-1 bg-bg-card border border-border rounded px-1.5 py-1.5 text-[11px] text-fg outline-none">
                <option value="">All brands</option>
                {brands.map((b) => <option key={b.value} value={b.value}>{b.label}</option>)}
              </select>
              <button onClick={syncFromDrive} disabled={syncBusy || !binBrand} title="Import new files from the brand's Google Drive folder"
                className="px-2 inline-flex items-center gap-1 rounded border border-border text-fg-muted hover:text-fg hover:border-brand text-[11px] disabled:opacity-50">
                <RefreshCw size={11} className={syncBusy ? "animate-spin" : ""} /> Sync Drive
              </button>
            </div>
            {(syncMsg || embedMsg) && <div className="text-[10px] text-fg-subtle">{syncMsg}{syncMsg && embedMsg ? " · " : ""}{embedMsg}</div>}
            <input value={brandQ} onChange={(e) => setBrandQ(e.target.value)} placeholder="Search brand assets…" className="w-full bg-bg-card border border-border rounded px-2 py-1.5 text-[11px] text-fg outline-none focus:border-brand" />
            {libCats.length > 0 && (
              <div className="flex items-center gap-1 flex-wrap text-[10px]">
                <button onClick={() => { setBinCategory("all"); setBinSub("all"); }} className={`px-2 py-0.5 rounded ${binCategory === "all" ? "bg-brand/15 text-brand" : "text-fg-subtle hover:text-fg"}`}>all</button>
                {libCats.map((c) => (
                  <button key={c} onClick={() => { setBinCategory(c); setBinSub("all"); }} className={`px-2 py-0.5 rounded ${binCategory === c ? "bg-brand/15 text-brand" : "text-fg-subtle hover:text-fg"}`}>{CAT_LABEL[c] ?? c}</button>
                ))}
              </div>
            )}
            {libSubs.length > 0 && libSubs.length <= 6 && (
              <div className="flex items-center gap-1 flex-wrap text-[10px]">
                <span className="text-fg-subtle">↳</span>
                <button onClick={() => setBinSub("all")} className={`px-2 py-0.5 rounded ${binSub === "all" ? "bg-brand/15 text-brand" : "text-fg-subtle hover:text-fg"}`}>all</button>
                {libSubs.map((sp) => (
                  <button key={sp} onClick={() => setBinSub(sp)} title={sp} className={`px-2 py-0.5 rounded max-w-[110px] truncate ${binSub === sp ? "bg-brand/15 text-brand" : "text-fg-subtle hover:text-fg"}`}>{sp}</button>
                ))}
              </div>
            )}
            {libSubs.length > 6 && (
              <label className="flex items-center gap-1.5 text-[10px] text-fg-subtle">↳
                <select value={binSub} onChange={(e) => setBinSub(e.target.value)} className="flex-1 bg-bg-card border border-border rounded px-1.5 py-1 text-[11px] text-fg outline-none">
                  <option value="all">All subfolders ({libSubs.length})</option>
                  {libSubs.map((sp) => <option key={sp} value={sp}>{sp}</option>)}
                </select>
              </label>
            )}
            <div className="flex items-center gap-1 text-[10px]">
              {(["all", "video", "image", "audio"] as const).map((f) => (
                <button key={f} onClick={() => setBinFilter(f)} className={`px-2 py-0.5 rounded ${binFilter === f ? "bg-brand/15 text-brand" : "text-fg-subtle hover:text-fg"}`}>{f}</button>
              ))}
              <div className="ml-auto flex items-center gap-1">
                <select value={binAspect} onChange={(e) => setBinAspect(e.target.value)} title="Aspect ratio" className="bg-bg-card border border-border rounded px-1 py-0.5 text-fg-muted outline-none">
                  <option value="all">ratio</option><option value="1:1">1:1</option><option value="4:5">4:5</option><option value="9:16">9:16</option><option value="16:9">16:9</option><option value="3:4">3:4</option><option value="2:3">2:3</option><option value="Portrait">portrait</option><option value="Landscape">landscape</option>
                </select>
                <select value={binSort} onChange={(e) => setBinSort(e.target.value as typeof binSort)} className="bg-bg-card border border-border rounded px-1 py-0.5 text-fg-muted outline-none">
                  <option value="newest">Newest</option><option value="oldest">Oldest</option><option value="az">Name A–Z</option><option value="za">Name Z–A</option><option value="kind">Type</option><option value="duration">Duration</option>
                </select>
              </div>
            </div>
          </div>
          {assetGrid(brandBin)}
        </>)}

        {railTab === "audio" && (<>
          <div className="shrink-0 border-b border-border/50 p-2 text-[10px] text-fg-subtle">Music & sound from uploads, generations and the brand kit.</div>
          {assetGrid(audioBin)}
        </>)}

        {railTab === "effects" && (
          <div className="flex-1 min-h-0 overflow-y-auto p-2">
            <div className="text-[10px] text-fg-subtle px-1 pb-2">Overlay effect — added as a clip on a new top layer.</div>
            <div className="grid grid-cols-2 gap-2">
              {FX.map((f) => (
                <button key={f.v} onClick={() => addFx(f.v)} style={{ backgroundImage: DEMO_BG, backgroundSize: "cover" }} className="relative aspect-video rounded-md overflow-hidden border border-border hover:border-brand bg-black flex items-end justify-center group">
                  <div className="absolute inset-0" style={fxStyle(f.v)} />
                  <span className="relative z-10 mb-1 px-1.5 py-0.5 rounded bg-black/60 text-[10px] text-white font-medium inline-flex items-center gap-1"><Sparkles size={11} /> {f.l}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {railTab === "filters" && (
          <div className="flex-1 min-h-0 overflow-y-auto p-2">
            <div className="text-[10px] text-fg-subtle px-1 pb-2">Filter — added as a clip; affects only layers below it.</div>
            <div className="grid grid-cols-2 gap-2">
              {ADJUST.map((f) => (
                <button key={f.v} onClick={() => addAdjust(f.v)} className="relative aspect-video rounded-md overflow-hidden border border-border hover:border-brand bg-black flex items-end justify-center">
                  <div className="absolute inset-0" style={{ backgroundImage: DEMO_BG, backgroundSize: "cover", filter: f.v }} />
                  <span className="relative z-10 mb-1 px-1.5 py-0.5 rounded bg-black/60 text-[10px] text-white font-medium inline-flex items-center gap-1"><Wand2 size={11} /> {f.l}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {railTab === "text" && (
          <div className="flex-1 min-h-0 overflow-y-auto p-2 space-y-2">
            <button onClick={() => addText()} className="w-full inline-flex items-center justify-center gap-1.5 py-2.5 rounded-md border border-border text-fg-muted hover:text-fg hover:border-brand text-[12px]"><Type size={13} /> Add plain text</button>
            <div className="text-fg-muted text-[11px] font-medium pt-1">Text presets</div>
            <div className="grid grid-cols-2 gap-2">
              {([
                ["Title", { color: "#ffffff", weight: 900, size: 1.6, shadow: true, plate: "none", pos: "center", upper: true }, "TITLE"],
                ["Heading", { color: "#ffffff", weight: 800, size: 1.2, shadow: true, plate: "none", pos: "top" }, "Heading"],
                ["Body", { color: "#ffffff", weight: 600, size: 0.85, shadow: true, plate: "none", pos: "center" }, "Body text"],
                ["Lower third", { color: "#ffffff", weight: 800, size: 0.8, plate: "full", plateColor: "rgba(0,0,0,0.78)", radius: 0.22, shadow: false, pos: "bottom" }, "Lower third"],
                ["Outline", { color: "#ffffff", weight: 900, size: 1.2, stroke: "#000000", strokeW: 0.1, shadow: false, plate: "none", pos: "center", upper: true }, "OUTLINE"],
                ["Accent box", { color: "#111111", weight: 900, size: 1, plate: "full", plateColor: "#FFD60A", radius: 0.3, shadow: false, pos: "center", upper: true }, "ACCENT"],
              ] as const).map(([name, style, sample]) => (
                <button key={name} onClick={() => addText(style as TextStyle, name, sample)}
                  className="rounded-md border border-border hover:border-brand bg-black aspect-video flex items-center justify-center overflow-hidden">
                  <span style={{
                    color: (style as TextStyle).plate === "full" && (style as TextStyle).plateColor === "#FFD60A" ? "#111" : (style as TextStyle).color,
                    fontWeight: (style as TextStyle).weight,
                    fontSize: 12 * ((style as TextStyle).size ?? 1),
                    background: (style as TextStyle).plate === "full" ? (style as TextStyle).plateColor : undefined,
                    padding: (style as TextStyle).plate === "full" ? "2px 6px" : undefined,
                    borderRadius: 4,
                    WebkitTextStroke: (style as TextStyle).stroke ? `1px ${(style as TextStyle).stroke}` : undefined,
                    textShadow: (style as TextStyle).shadow !== false ? "0 1px 4px rgba(0,0,0,0.8)" : undefined,
                  }}>{sample}</span>
                </button>
              ))}
            </div>
            <div className="text-[10px] text-fg-subtle px-1">Plain text — no animation by default. Select it, then add an entrance animation and styling in <b>Captions → Caption style</b> or tweak it in Properties.</div>
          </div>
        )}

        {railTab === "subs" && (
          <div className="flex-1 min-h-0 overflow-y-auto p-2 space-y-2 text-[11px]">
            <label className="block text-fg-muted">Source
              <select value={subSource} onChange={(e) => setSubSource(e.target.value)} className="mt-1 w-full bg-bg-card border border-border rounded px-2 py-1.5 text-fg outline-none">
                {subSources.length === 0 && <option value="">No video/audio on timeline</option>}
                {subSources.map((c) => <option key={c.id} value={c.id}>{c.label} ({c.kind})</option>)}
              </select>
            </label>
            <label className="block text-fg-muted">Split
              <select value={subMode} onChange={(e) => setSubMode(e.target.value as SplitMode)} className="mt-1 w-full bg-bg-card border border-border rounded px-2 py-1.5 text-fg outline-none">
                <option value="word">One word</option>
                <option value="two">Two words</option>
                <option value="three">Three words</option>
                <option value="smart">Smart (phrases)</option>
                <option value="sentence">Sentences</option>
                <option value="line">Full line (~40 chars)</option>
              </select>
            </label>
            <label className="flex items-center gap-1.5 text-fg-muted"><input type="checkbox" checked={subEmoji} onChange={(e) => setSubEmoji(e.target.checked)} /> Auto emoji ✨</label>
            <button onClick={generateSubtitles} disabled={subBusy || subSources.length === 0}
              className="w-full inline-flex items-center justify-center gap-1.5 py-2.5 rounded-md bg-brand text-white text-[12px] font-medium disabled:opacity-50">
              {subBusy ? <><Loader2 size={14} className="animate-spin" /> Working…</> : <><Sparkles size={14} /> Generate subtitles</>}
            </button>
            {subStatus && <div className="text-fg-subtle">{subStatus}</div>}

            <div className="pt-2 border-t border-border/40 space-y-2">
              <div className="text-fg-muted font-medium">Caption style <span className="text-fg-subtle font-normal">— applies to selected captions, or all if none selected</span></div>
              <div className="grid grid-cols-3 gap-1.5">
                {CAP_PRESETS.map((p) => (
                  <button key={p.key} onClick={() => { setCapPreset(p.key); applyStyle({ ...p.style }); }}
                    className={`rounded border px-1 py-2 text-[10px] ${capPreset === p.key ? "border-brand bg-brand/10 text-brand" : "border-border text-fg-muted hover:border-brand/50"}`}>
                    {p.label}
                  </button>
                ))}
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                <label className="text-fg-muted">Position
                  <select value={capStyle.pos || "bottom"} onChange={(e) => applyStyle({ ...capStyle, pos: e.target.value as TextStyle["pos"] })} className="mt-0.5 w-full bg-bg-card border border-border rounded px-1.5 py-1 text-fg outline-none">
                    <option value="bottom">Bottom</option><option value="center">Center</option><option value="top">Top</option>
                  </select>
                </label>
                <label className="text-fg-muted">Animation
                  <select value={capStyle.enter || ""} onChange={(e) => applyStyle({ ...capStyle, enter: e.target.value as TextStyle["enter"] })} className="mt-0.5 w-full bg-bg-card border border-border rounded px-1.5 py-1 text-fg outline-none">
                    <option value="">None</option><option value="fade">Fade</option><option value="scale">Scale</option><option value="zoomIn">Zoom in</option><option value="bounce">Bounce</option><option value="spin">Spin</option><option value="slideUp">Slide up</option><option value="slideDown">Slide down</option><option value="wipeRight">Wipe right</option><option value="wipeLeft">Wipe left</option><option value="blurIn">Blur in</option><option value="wordsUp">Words up</option><option value="typewriter">Typewriter</option>
                  </select>
                </label>
            <label className="block text-fg-muted">Exit animation
              <select value={capStyle.exit ?? ""} onChange={(e) => applyStyle({ exit: e.target.value as TextStyle["exit"] })} className="mt-1 w-full bg-bg-card border border-border rounded px-2 py-1.5 text-fg outline-none">
                <option value="">None</option><option value="fade">Fade</option><option value="scale">Scale</option><option value="zoomOut">Zoom out</option><option value="slideUp">Slide up</option><option value="slideDown">Slide down</option><option value="wipeLeft">Wipe left</option><option value="wipeRight">Wipe right</option><option value="blurOut">Blur out</option>
              </select>
            </label>
            <label className="block text-fg-muted">Loop
              <select value={capStyle.loop ?? ""} onChange={(e) => applyStyle({ loop: e.target.value as TextStyle["loop"] })} className="mt-1 w-full bg-bg-card border border-border rounded px-2 py-1.5 text-fg outline-none">
                <option value="">None</option><option value="pulse">Pulse</option><option value="float">Float</option><option value="wiggle">Wiggle</option>
              </select>
            </label>
                <label className="text-fg-muted col-span-2">Size
                  <input type="range" min={0.5} max={2} step={0.05} value={capStyle.size ?? 1} onChange={(e) => applyStyle({ ...capStyle, size: Number(e.target.value) })} className="mt-1 w-full" />
                </label>
                <label className="text-fg-muted col-span-2">Font
                  <select value={capStyle.font || "sans-serif"} onChange={(e) => applyStyle({ ...capStyle, font: e.target.value })} className="mt-0.5 w-full bg-bg-card border border-border rounded px-1.5 py-1 text-fg outline-none">
                    {CAP_FONTS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
                  </select>
                </label>
                <label className="text-fg-muted flex items-center gap-1.5"><input type="checkbox" checked={!!capStyle.upper} onChange={(e) => applyStyle({ ...capStyle, upper: e.target.checked })} /> UPPERCASE</label>
                <label className="text-fg-muted flex items-center gap-1.5"><input type="checkbox" checked={capStyle.shadow !== false} onChange={(e) => applyStyle({ ...capStyle, shadow: e.target.checked })} /> Shadow</label>
                <label className="text-fg-muted flex items-center gap-1.5"><input type="checkbox" checked={!!capStyle.noPunct} onChange={(e) => applyStyle({ ...capStyle, noPunct: e.target.checked })} /> No punctuation</label>
                <label className="text-fg-muted">Shadow color
                  <input type="color" value={capStyle.shadowColor || "#000000"} onChange={(e) => applyStyle({ ...capStyle, shadowColor: e.target.value })} className="mt-0.5 w-full h-7 bg-bg-card border border-border rounded cursor-pointer" />
                </label>
                <label className="text-fg-muted">Weight
                  <select value={String(capStyle.weight ?? 800)} onChange={(e) => applyStyle({ ...capStyle, weight: Number(e.target.value) })} className="mt-0.5 w-full bg-bg-card border border-border rounded px-1.5 py-1 text-fg outline-none">
                    {[400, 600, 700, 800, 900].map((w) => <option key={w} value={w}>{w}</option>)}
                  </select>
                </label>
                <label className="text-fg-muted">Corner radius
                  <input type="range" min={0} max={0.5} step={0.02} value={capStyle.radius ?? 0.22} onChange={(e) => applyStyle({ ...capStyle, radius: Number(e.target.value) })} className="mt-1 w-full" />
                </label>
                <label className="text-fg-muted">Outline width
                  <input type="range" min={0} max={0.2} step={0.01} value={capStyle.strokeW ?? 0} onChange={(e) => applyStyle({ ...capStyle, strokeW: Number(e.target.value), stroke: capStyle.stroke || "#000000" })} className="mt-1 w-full" />
                </label>
                <label className="text-fg-muted">Outline color
                  <input type="color" value={capStyle.stroke || "#000000"} onChange={(e) => applyStyle({ ...capStyle, stroke: e.target.value })} className="mt-0.5 w-full h-7 bg-bg-card border border-border rounded cursor-pointer" />
                </label>
                <label className="text-fg-muted">Text color
                  <input type="color" value={capStyle.color || "#ffffff"} onChange={(e) => applyStyle({ ...capStyle, color: e.target.value })} className="mt-0.5 w-full h-7 bg-bg-card border border-border rounded cursor-pointer" />
                </label>
                <label className="text-fg-muted">{capStyle.plate === "word" ? "Plate color" : capStyle.plate === "full" ? "Plate color" : "Highlight color"}
                  <input type="color"
                    value={(capStyle.plate === "word" || capStyle.plate === "full" ? capStyle.plateColor : capStyle.highlight) || "#FFD60A"}
                    onChange={(e) => applyStyle(capStyle.plate === "word" || capStyle.plate === "full" ? { ...capStyle, plateColor: e.target.value } : { ...capStyle, highlight: e.target.value })}
                    className="mt-0.5 w-full h-7 bg-bg-card border border-border rounded cursor-pointer" />
                </label>
              </div>
              <div className="flex gap-1.5 pt-0.5">
                <button onClick={applyStyleAll} className="flex-1 py-1.5 rounded border border-border text-fg-muted hover:text-fg hover:border-brand">Apply to all captions</button>
                <button onClick={applyStyleSelected} disabled={!selTextCount} className="flex-1 py-1.5 rounded border border-border text-fg-muted hover:text-fg hover:border-brand disabled:opacity-40">Apply to selected{selTextCount ? ` (${selTextCount})` : ""}</button>
              </div>
              <div className="flex items-center justify-between pt-1">
                <span className="text-fg-muted font-medium">My presets</span>
                <button onClick={savePreset} className="px-2 py-1 rounded border border-border text-fg-muted hover:text-fg hover:border-brand">Save current</button>
              </div>
              {savedPresets.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {savedPresets.map((p) => (
                    <span key={p.name} className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-1">
                      <button onClick={() => { setCapPreset(""); applyStyle({ ...p.style }); }} className="text-fg-muted hover:text-brand">{p.name}</button>
                      <button onClick={() => deletePreset(p.name)} className="text-fg-subtle hover:text-red-400">×</button>
                    </span>
                  ))}
                </div>
              )}
              <div className="text-[10px] text-fg-subtle">Change preset/colors → applies live (selected, or all). Buttons re-apply to existing captions without re-transcribing.</div>
            </div>
          </div>
        )}
      </aside>

      {/* Main */}
      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        <div className="h-11 shrink-0 border-b border-border flex items-center justify-between px-3 gap-2">
          <div className="flex items-center gap-2 text-fg text-[13px] font-medium"><Clapperboard size={14} className="text-brand" /> Editor</div>
          <div className="flex items-center gap-2">
            {workflowId && projectId && (
              <a href={`/projects/${projectId}/workflows/${workflowId}`} title="Back to the node canvas of this project"
                className="px-2 py-1 rounded border border-border text-[11px] text-fg-muted hover:text-fg hover:border-brand">← Canvas</a>
            )}
            <span className="text-[10px] text-fg-subtle w-12 text-right">{saveState === "saving" ? "Saving…" : saveState === "saved" ? "Saved ✓" : ""}</span>
            <button onClick={saveProject} className="px-2 py-1 rounded border border-border text-[11px] text-fg-muted hover:text-fg hover:border-brand">Save</button>
            <button onClick={newProject} className="px-2 py-1 rounded border border-border text-[11px] text-fg-muted hover:text-fg hover:border-brand">New</button>
            <select value={resKey} onChange={(e) => setResKey(e.target.value)} className="bg-bg-card border border-border rounded-md px-2 py-1 text-[11px] text-fg-muted outline-none">
              {RESOLUTIONS.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
            </select>
            <button onClick={exportMp4} disabled={exporting || !clips.length} className="px-3 py-1.5 rounded-md bg-brand text-black font-medium text-[12px] disabled:opacity-50 inline-flex items-center gap-1.5">
              {exporting ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}{exporting ? `${progress}%` : "Export MP4"}
            </button>
            {workflowId && (
              <button onClick={exportToCanvas} disabled={sendingToCanvas || exporting || !clips.length} title="Render and set as the Editor node's output on the canvas"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-border text-[11px] text-fg-muted hover:text-fg hover:border-brand disabled:opacity-50">
                {sendingToCanvas ? <Loader2 size={13} className="animate-spin" /> : null}{sendingToCanvas ? `${progress}%` : "→ Canvas"}
              </button>
            )}
          </div>
        </div>

        {/* Preview */}
        <div ref={containerRef} className="flex-1 min-h-0 bg-black flex items-center justify-center overflow-hidden relative"
          onWheel={onViewWheel} onPointerDown={onPanDown}>
          {clips.length > 0 ? (
            <div className="absolute inset-0 flex items-center justify-center" style={{ overflow: "visible" }}>
              <div style={{ transform: `translate(${viewPan.x}px, ${viewPan.y}px) scale(${viewZoom})`, transformOrigin: "center" }}>
                <div className="relative bg-black ring-1 ring-white/20" style={{ width: previewSize.w, height: previewSize.h, overflow: "visible" }}>
                  <div className="absolute inset-0" style={{ overflow: "visible" }}>
                    {zClips.map((c) => {
                      if (c.kind === "fx") return isActive(c, t)
                        ? <div key={c.id} className="absolute inset-0 pointer-events-none" style={{ ...fxStyle(c.fx), opacity: alphaAt(c, t) || 1 }} />
                        : null;
                      if (c.kind === "adjust") return isActive(c, t) && c.fx
                        ? <div key={c.id} className="absolute inset-0 pointer-events-none" style={{ backdropFilter: c.fx, WebkitBackdropFilter: c.fx as string, opacity: alphaAt(c, t) || 1 }} />
                        : null;
                      if (c.kind === "text") return null; // captions are drawn on the canvas overlay (pixel-identical to export)
                      const active = isActive(c, t);
                      const isSel = selectedIds.includes(c.id);
                      const v = clipVisual(c as CompClip, t, clips as CompClip[]);
                      const w3d = warpStyle(c, v.opacity, t);
                      return (
                        <div key={c.id} className="absolute inset-0"
                          style={{ ...(w3d ?? styleFromVisual(c, v)), mixBlendMode: (c.blend || undefined) as React.CSSProperties["mixBlendMode"], pointerEvents: active ? "auto" : "none", cursor: "move", touchAction: "none" }}
                          onPointerDown={(e) => onVpDown(e, c, "move")} onContextMenu={(e) => onClipContext(e, c)}>
                          {c.kind === "image" && !c.keyColor && (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={c.url} alt="" draggable={false} className={`absolute inset-0 w-full h-full ${w3d ? "object-fill" : "object-contain"} pointer-events-none`} />
                          )}
                          {c.kind === "image" && c.keyColor && <KeyedImage url={c.url!} keyColor={c.keyColor} keyTol={c.keyTol ?? 0.3} />}
                          {c.kind === "video" && !c.keyColor && (
                            <video src={c.url} playsInline preload="metadata" onLoadedMetadata={(e) => onMeta(c.id, e.currentTarget.duration)} ref={(el) => { if (el) mediaRefs.current.set(c.id, el); else mediaRefs.current.delete(c.id); }}
                              className={`absolute inset-0 w-full h-full ${w3d ? "object-fill" : "object-contain"} pointer-events-none`} />
                          )}
                          {c.kind === "video" && c.keyColor && (
                            <KeyedVideo url={c.url!} keyColor={c.keyColor} keyTol={c.keyTol ?? 0.3}
                              register={(el) => { if (el) mediaRefs.current.set(c.id, el); else mediaRefs.current.delete(c.id); }}
                              onMeta={(d) => onMeta(c.id, d)} />
                          )}
                          {isSel && active && <div className="absolute inset-0 ring-2 ring-brand pointer-events-none" />}
                          {selected === c.id && active && (
                            <div onPointerDown={(e) => onVpDown(e, c, "scale")} className="absolute bottom-1 right-1 w-3.5 h-3.5 bg-brand rounded-sm cursor-nwse-resize" style={{ touchAction: "none" }} />)}
                        </div>
                      );
                    })}
                  </div>
                  {/* captions drawn with the SAME routine as the MP4 export → preview == export */}
                  <canvas ref={capCanvasRef} className="absolute inset-0 pointer-events-none z-[9]" style={{ width: previewSize.w, height: previewSize.h }} />
                  {!playing && capRects.map((r) => {
                    const c = clips.find((x) => x.id === r.id); if (!c) return null;
                    const isSel = selectedIds.includes(r.id);
                    return (
                      <div key={r.id} className={`absolute z-[9] ${isSel ? "ring-2 ring-brand" : "hover:ring-1 hover:ring-brand/60"}`}
                        style={{ left: r.x, top: r.y, width: r.w, height: r.h, cursor: "move", touchAction: "none" }}
                        onPointerDown={(e) => onCapDown(e, c)} onContextMenu={(e) => onClipContext(e, c)}>
                        {isSel && <div onPointerDown={(e) => onCapScale(e, c)} className="absolute -bottom-1.5 -right-1.5 w-3.5 h-3.5 bg-brand rounded-sm cursor-nwse-resize" style={{ touchAction: "none" }} />}
                      </div>
                    );
                  })}
                  {/* dim everything outside the composition (pasteboard), content stays visible & grabbable */}
                  <div className="absolute inset-0 pointer-events-none z-10" style={{ boxShadow: "0 0 0 99999px rgba(0,0,0,0.55)" }} />
                  <div className="absolute inset-0 ring-1 ring-white/30 pointer-events-none z-10" />
                  <div className="absolute inset-[5%] border border-white/10 pointer-events-none z-10" />
                  {snap.v && <div className="absolute left-1/2 top-0 bottom-0 w-px -translate-x-1/2 bg-fuchsia-400 pointer-events-none z-20" />}
                  {snap.h && <div className="absolute top-1/2 left-0 right-0 h-px -translate-y-1/2 bg-fuchsia-400 pointer-events-none z-20" />}
                </div>
              </div>
              {clips.filter((c) => c.kind === "audio").map((c) => (
                <audio key={c.id} src={c.url} preload="metadata" onLoadedMetadata={(e) => onMeta(c.id, e.currentTarget.duration)} ref={(el) => { if (el) mediaRefs.current.set(c.id, el); else mediaRefs.current.delete(c.id); }} />
              ))}
            </div>
          ) : (<div className="text-fg-subtle text-[12px]">Add or drag assets from the left to start.</div>)}

          {clips.length > 0 && (
            <div onPointerDown={(e) => e.stopPropagation()} className="absolute bottom-2 right-2 z-30 flex items-center gap-1 bg-bg-card/90 border border-border rounded px-1.5 py-1 text-[11px] text-fg-muted">
              <button onClick={() => setViewZoom((z) => Math.max(0.1, +(z / 1.2).toFixed(3)))} className="hover:text-fg" title="Zoom out"><ZoomOut size={13} /></button>
              <span className="tabular-nums w-9 text-center">{Math.round(viewZoom * 100)}%</span>
              <button onClick={() => setViewZoom((z) => Math.min(8, +(z * 1.2).toFixed(3)))} className="hover:text-fg" title="Zoom in"><ZoomIn size={13} /></button>
              <button onClick={fitView} className="hover:text-fg ml-1">Fit</button>
            </div>
          )}
        </div>

        {/* Transport */}
        <div className="h-9 shrink-0 border-t border-border flex items-center gap-3 px-3 text-[11px] text-fg-muted">
          <button onClick={() => seek(0)} className="hover:text-fg"><SkipBack size={14} /></button>
          <button onClick={play} className="text-fg hover:text-brand">{playing ? <Pause size={16} /> : <Play size={16} />}</button>
          <button onClick={undo} title="Undo (Cmd/Ctrl+Z)" className="hover:text-fg text-[13px] leading-none">↺</button>
          <button onClick={redo} title="Redo (Shift+Cmd/Ctrl+Z)" className="hover:text-fg text-[13px] leading-none">↻</button>
          <span className="w-px h-4 bg-border" />
          <button onClick={splitAtPlayhead} title="Split at playhead (S)" className="hover:text-fg"><Scissors size={13} /></button>
          <button onClick={duplicateSelected} disabled={!selectedIds.length} title="Duplicate (Cmd/Ctrl+D)" className="hover:text-fg disabled:opacity-30"><Copy size={13} /></button>
          <button onClick={() => removeMany(selectedIds)} disabled={!selectedIds.length} title="Delete selected" className="hover:text-red-400 disabled:opacity-30"><Trash2 size={13} /></button>
          <span className="tabular-nums">{fmt(playhead)} / {fmt(totalDur)}</span>
          <div className="ml-auto flex items-center gap-2">
            <button onClick={() => setPxPerSec((z) => Math.max(2, Math.round(z * 0.8)))} className="hover:text-fg" title="Zoom out (Cmd/Ctrl+wheel)"><ZoomOut size={13} /></button>
            <button onClick={() => setPxPerSec((z) => Math.min(400, Math.round(z * 1.25)))} className="hover:text-fg" title="Zoom in (Cmd/Ctrl+wheel)"><ZoomIn size={13} /></button>
            <input type="range" min={28} max={96} step={2} value={laneH} onChange={(e) => setLaneH(Number(e.target.value))} title="Track height (Alt+wheel)" className="w-14" />
            <button onClick={() => { const w = (typeof window !== "undefined" ? window.innerWidth : 1200) - leftW - rightW - 200; setPxPerSec(Math.min(400, Math.max(2, Math.floor(w / Math.max(1, totalDur))))); }} title="Fit timeline to window" className="px-1.5 py-0.5 rounded border border-border text-fg-muted hover:text-fg text-[10px]">Fit</button>
          </div>
          {status && <span className="text-fg-subtle truncate max-w-[35%]">· {status}</span>}
        </div>

        {/* Resize handle — drag up to make the timeline taller (see more layers) */}
        <div onPointerDown={onResizeDown} onPointerMove={onResizeMove} onPointerUp={onResizeUp}
          className="h-2 shrink-0 cursor-ns-resize bg-border/40 hover:bg-brand/50 border-t border-border flex items-center justify-center group" title="Drag to resize timeline">
          <span className="w-8 h-0.5 rounded bg-fg-subtle/40 group-hover:bg-brand/70" />
        </div>

        {/* Timeline */}
        <div className="shrink-0 border-t border-border overflow-auto bg-bg-card/30 select-none" style={{ height: timelineH }}
          onPointerDown={onMarqueeDown} onPointerMove={onClipPointerMove} onPointerUp={onClipPointerUp} onPointerLeave={onClipPointerUp}
          onWheel={(e) => {
            if (e.metaKey || e.ctrlKey) { e.preventDefault(); setPxPerSec((z) => Math.min(400, Math.max(2, Math.round(z * (e.deltaY < 0 ? 1.12 : 0.89))))); }
            else if (e.altKey) { e.preventDefault(); setLaneH((h) => Math.min(96, Math.max(28, h + (e.deltaY < 0 ? 4 : -4)))); }
          }}>
          <div style={{ width: Math.max(800, totalDur * pxPerSec + 120) }}>
            <div data-ruler className="sticky top-0 z-30 flex bg-bg-card border-b border-border/60">
              <div className="w-28 shrink-0 border-r border-border/40 sticky left-0 z-20 bg-bg-card" />
              <div className="relative flex-1 h-6 cursor-ew-resize touch-none" onPointerDown={onRulerDown} onPointerMove={onRulerMove} onPointerUp={onRulerUp}>
                {(() => {
                  const steps = [0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
                  const step = steps.find((st) => st * pxPerSec >= 56) ?? 600;
                  const fmtTick = (sec: number) => sec >= 60 ? `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, "0")}` : `${+sec.toFixed(2)}s`;
                  const n = Math.ceil(totalDur / step) + 1;
                  return Array.from({ length: n }).map((_, i) => {
                    const sec = i * step;
                    return (
                      <div key={i} className="absolute top-0 h-full border-l border-border/50 text-[8px] text-fg-subtle pl-1 pointer-events-none" style={{ left: sec * pxPerSec }}>{fmtTick(sec)}</div>
                    );
                  });
                })()}
                {(() => {
                  const sec = clips.filter((c) => c.section);
                  if (!sec.length) return null;
                  const names = Array.from(new Set(sec.map((c) => c.section as string)));
                  const COLORS: Record<string, string> = { Hook: "#f59e0b", Body: "#38bdf8", Packshot: "#a78bfa", CTA: "#34d399" };
                  return names.map((name) => {
                    const cs = sec.filter((c) => c.section === name);
                    const s0 = Math.min(...cs.map((c) => c.start));
                    const s1 = Math.max(...cs.map((c) => c.start + c.duration));
                    return (
                      <div key={name} className="absolute bottom-0 h-1.5 rounded-sm pointer-events-none flex items-center" style={{ left: s0 * pxPerSec, width: Math.max(8, (s1 - s0) * pxPerSec), background: (COLORS[name] ?? "#888") + "66", boxShadow: `inset 0 -1.5px 0 ${COLORS[name] ?? "#888"}` }}>
                        <span className="text-[7px] leading-none px-1 -translate-y-2.5" style={{ color: COLORS[name] ?? "#888" }}>{name}</span>
                      </div>
                    );
                  });
                })()}
                <div className="absolute top-0 bottom-0 w-0.5 bg-brand pointer-events-none z-20" style={{ left: playhead * pxPerSec }} />
              </div>
            </div>
            {layers.map((layer, li) => (
              <div key={layer.id}>
                {/* insertion strip above this layer */}
                <div className="flex h-2.5 items-center">
                  <div className="w-28 shrink-0 sticky left-0 z-20" />
                  <div ref={(el) => { if (el) stripRefs.current.set(`strip-${li}`, el); else stripRefs.current.delete(`strip-${li}`); }}
                    onDragOver={(e) => { e.preventDefault(); setDropHint({ type: "strip", id: `strip-${li}` }); }}
                    onDragLeave={() => setDropHint((h) => (h?.type === "strip" && h.id === `strip-${li}` ? null : h))}
                    onDrop={(e) => onStripDrop(e, li)}
                    className={`flex-1 rounded transition-all ${dropHint?.type === "strip" && dropHint.id === `strip-${li}` ? "h-2.5 bg-brand/50 ring-1 ring-brand" : "h-0.5 bg-border/30"}`} />
                </div>
                <div className="flex items-stretch border-b border-border/40 min-h-[48px]">
                  <div data-label onClick={() => setSelectedLayer(layer.id)} onDoubleClick={() => setRenamingLayer(layer.id)}
                    style={{ boxShadow: `inset 3px 0 0 ${layer.type === "video" ? "#38bdf8" : layer.type === "image" ? "#a78bfa" : layer.type === "text" ? "#f59e0b" : layer.type === "effect" ? "#c084fc" : "#34d399"}` }}
                    className={`w-28 shrink-0 flex items-center gap-1 px-1.5 text-[9px] uppercase tracking-wider border-r border-border/40 cursor-pointer sticky left-0 z-20 ${selectedLayer === layer.id ? "bg-brand/15 text-brand bg-bg-card" : "text-fg-subtle hover:text-fg bg-bg-card"}`}>
                    {renamingLayer === layer.id ? (
                      <input autoFocus defaultValue={labelFor(layer)} onClick={(e) => e.stopPropagation()}
                        onBlur={(e) => { renameLayer(layer.id, e.target.value); setRenamingLayer(null); }}
                        onKeyDown={(e) => { if (e.key === "Enter") { renameLayer(layer.id, (e.target as HTMLInputElement).value); setRenamingLayer(null); } if (e.key === "Escape") setRenamingLayer(null); }}
                        className="w-full bg-bg border border-brand rounded px-1 py-0.5 text-fg outline-none normal-case" />
                    ) : (<>
                      <span className="truncate flex-1" title="Click to select · double-click to rename">{labelFor(layer)}</span>
                      <button onClick={(e) => { e.stopPropagation(); setLayers((p) => p.map((l) => (l.id === layer.id ? { ...l, hidden: !l.hidden } : l))); }}
                        title={layer.hidden ? "Show layer" : "Hide layer"} className={layer.hidden ? "text-fg-subtle/50" : "hover:text-fg"}>
                        {layer.hidden ? <EyeOff size={11} /> : <Eye size={11} />}
                      </button>
                      <button onClick={(e) => { e.stopPropagation(); setLayers((p) => p.map((l) => (l.id === layer.id ? { ...l, locked: !l.locked } : l))); }}
                        title={layer.locked ? "Unlock layer" : "Lock layer"} className={layer.locked ? "text-amber-400" : "hover:text-fg"}>
                        {layer.locked ? <Lock size={11} /> : <Unlock size={11} />}
                      </button>
                    </>)}
                  </div>
                  <div ref={(el) => { if (el) laneRefs.current.set(layer.id, el); else laneRefs.current.delete(layer.id); }}
                    style={{ height: laneH }} className={`relative flex-1 ${dropHint?.type === "lane" && dropHint.id === layer.id ? "bg-brand/10 ring-1 ring-inset ring-brand/50" : selectedLayer === layer.id ? "bg-brand/[0.04]" : ""}`}
                    onClick={() => setSelectedLayer(layer.id)}
                    onDragOver={(e) => { e.preventDefault(); setDropHint({ type: "lane", id: layer.id }); }}
                    onDragLeave={() => setDropHint((h) => (h?.type === "lane" && h.id === layer.id ? null : h))}
                    onDrop={(e) => onLaneDrop(e, layer)}>
                    <div className="absolute top-0 bottom-0 w-0.5 bg-brand/60 pointer-events-none z-20" style={{ left: playhead * pxPerSec }} />
                    {onLayer(layer.id).map((c) => (
                      <div key={c.id} data-clip onPointerDown={(e) => onClipPointerDown(e, c, "move")} onClick={(e) => e.stopPropagation()} onContextMenu={(e) => onClipContext(e, c)}
                        style={{ left: c.start * pxPerSec, width: Math.max(24, c.duration * pxPerSec), top: 6, height: laneH - 12 }}
                        className={`absolute rounded text-[10px] cursor-grab active:cursor-grabbing border touch-none overflow-hidden flex items-center ${
                          selectedIds.includes(c.id) ? "border-brand bg-brand/20 text-brand z-10"
                          : c.kind === "fx" ? "border-purple-500/50 bg-purple-500/15 text-purple-300"
                          : c.kind === "adjust" ? "border-cyan-500/50 bg-cyan-500/15 text-cyan-300"
                          : c.kind === "text" ? "border-amber-500/50 bg-amber-500/15 text-amber-200"
                          : c.kind === "audio" ? "border-emerald-500/50 bg-emerald-600/20 text-emerald-200"
                          : c.kind === "image" ? "border-violet-500/50 bg-violet-500/15 text-violet-200"
                          : "border-sky-500/50 bg-sky-500/15 text-sky-200"}`}>
                        {c.kind === "video" && c.url && (() => {
                          const fs = filmstripCache.get(c.url);
                          if (fs === undefined) requestFilmstrip(c.url);
                          return fs
                            ? <span className="absolute inset-0 pointer-events-none opacity-80" style={{ backgroundImage: `url(${fs})`, backgroundSize: "auto 100%", backgroundRepeat: "repeat-x" }} />
                            : <span className="h-full w-8 shrink-0 overflow-hidden border-r border-black/40 bg-black"><video src={c.url} muted playsInline preload="metadata" className="w-full h-full object-cover pointer-events-none" /></span>;
                        })()}
                        {c.kind === "image" && c.url && (
                          <span className="h-full w-8 shrink-0 overflow-hidden border-r border-black/40 bg-black">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={c.url} alt="" draggable={false} className="w-full h-full object-cover pointer-events-none" />
                          </span>
                        )}
                        {c.kind === "audio" && c.url && (() => {
                          const all = wavePeaksCache.get(c.url);
                          if (all === undefined) requestWave(c.url);
                          if (!all) return null;
                          // show only the audible slice — trimming must cut the wave, not squeeze it
                          const sd = c.srcDur && c.srcDur > 0 ? c.srcDur : (c.inset || 0) + c.duration;
                          const i0 = Math.max(0, Math.floor(((c.inset || 0) / sd) * all.length));
                          const i1 = Math.min(all.length, Math.max(i0 + 2, Math.ceil((((c.inset || 0) + c.duration) / sd) * all.length)));
                          const peaks = all.slice(i0, i1);
                          const w = Math.max(24, c.duration * pxPerSec), h = laneH - 12;
                          const pts = peaks.map((v, i) => `${(i / (peaks.length - 1)) * w},${h / 2 - v * (h / 2 - 2)}`).join(" ");
                          const pts2 = peaks.map((v, i) => `${(i / (peaks.length - 1)) * w},${h / 2 + v * (h / 2 - 2)}`).reverse().join(" ");
                          return <svg className="absolute inset-0 pointer-events-none" width={w} height={h} preserveAspectRatio="none"><polygon points={`${pts} ${pts2}`} fill="rgba(110,231,183,0.45)" /></svg>;
                        })()}
                        <span className={`px-2 truncate leading-9 relative z-[1] ${c.kind === "video" ? "bg-black/40 rounded" : ""}`}>{c.kind === "fx" ? `FX: ${c.fx}` : c.kind === "adjust" ? `Adj: ${ADJUST.find((a) => a.v === c.fx)?.l ?? ""}` : c.kind === "text" ? (c.text || "Text") : c.label}</span>
                        <span onPointerDown={(e) => onClipPointerDown(e, c, "trimL")} className="absolute left-0 top-0 h-full w-2 cursor-ew-resize bg-brand/40 rounded-l z-[2]" />
                        <span onPointerDown={(e) => onClipPointerDown(e, c, "trim")} className="absolute right-0 top-0 h-full w-2 cursor-ew-resize bg-brand/40 rounded-r z-[2]" />
                      </div>
                    ))}
                    {/* transition "+" between adjacent clips (CapCut-style) */}
                    {(() => {
                      const lc = onLayer(layer.id).filter((c) => c.kind === "video" || c.kind === "image" || c.kind === "text");
                      return lc.map((b, idx) => {
                        if (idx === 0) return null;
                        const a = lc[idx - 1];
                        if (b.start > a.start + a.duration + 0.3) return null;
                        return (
                          <button key={`tr-${b.id}`}
                            onPointerDown={(e) => e.stopPropagation()}
                            onClick={(e) => { e.stopPropagation(); setTransMenu({ x: e.clientX, y: e.clientY, id: b.id }); }}
                            style={{ left: b.start * pxPerSec - 14 }} title="Transition"
                            className="absolute top-0 h-full z-40 grid place-items-center w-7 group">
                            <span className={`grid place-items-center w-6 h-6 rounded-full text-[12px] leading-none border shadow ${b.transType ? "bg-amber-400 text-black border-amber-200" : "bg-bg-card text-fg-muted border-border group-hover:border-brand group-hover:text-brand"}`}>
                              {b.transType ? "◆" : "+"}
                            </span>
                          </button>
                        );
                      });
                    })()}
                  </div>
                </div>
                {/* bottom insertion strip after the last layer */}
                {li === layers.length - 1 && (
                  <div className="flex h-2.5 items-center">
                    <div className="w-28 shrink-0 sticky left-0 z-20" />
                    <div ref={(el) => { if (el) stripRefs.current.set(`strip-${li + 1}`, el); else stripRefs.current.delete(`strip-${li + 1}`); }}
                      onDragOver={(e) => { e.preventDefault(); setDropHint({ type: "strip", id: `strip-${li + 1}` }); }}
                      onDragLeave={() => setDropHint((h) => (h?.type === "strip" && h.id === `strip-${li + 1}` ? null : h))}
                      onDrop={(e) => onStripDrop(e, li + 1)}
                      className={`flex-1 rounded transition-all ${dropHint?.type === "strip" && dropHint.id === `strip-${li + 1}` ? "h-2.5 bg-brand/50 ring-1 ring-brand" : "h-0.5 bg-border/30"}`} />
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

      </div>

      {/* Properties (right) — selected clip, resizable & collapsible */}
      {rightW === 0 && (
        <button onClick={() => setRightW(256)} title="Show Properties" className="shrink-0 w-5 border-l border-border text-fg-subtle hover:text-fg text-[10px]">‹</button>
      )}
      <aside style={{ width: rightW, display: rightW === 0 ? "none" : undefined }} className="relative shrink-0 border-l border-border flex flex-col min-h-0">
        <div onPointerDown={dragPanel("right")} className="absolute top-0 -left-1 w-2 h-full cursor-col-resize z-20" title="Drag to resize" />
        <div className="h-11 shrink-0 border-b border-border flex items-center justify-between px-3 text-[12px] font-medium text-fg">Properties
          <button onClick={() => setRightW(0)} title="Hide panel" className="text-fg-subtle hover:text-fg">›</button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto p-2 text-[11px]">
          {!sel && <div className="text-fg-subtle p-2">Select a clip on the timeline or in the viewport to edit its properties.</div>}
          {sel && (
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <span className="text-fg-subtle uppercase tracking-wider text-[10px]">{sel.kind}</span>
                <div className="flex gap-2">
                  <button onClick={() => duplicate(sel.id)} title="Duplicate" className="text-fg-muted hover:text-fg"><Copy size={12} /></button>
                  <button onClick={() => remove(sel.id)} title="Delete" className="text-red-400 hover:text-red-300"><Trash2 size={13} /></button>
                </div>
              </div>

              <div className="space-y-1.5">
                <div className="text-fg-muted font-medium">Basic</div>
                <input value={sel.label} onChange={(e) => update(sel.id, { label: e.target.value })} className="w-full bg-bg-card border border-border rounded px-2 py-1 text-fg outline-none focus:border-brand" placeholder="Name" />
                {sel.kind === "text" && (<textarea value={sel.text ?? ""} onChange={(e) => update(sel.id, { text: e.target.value })} rows={2} className="w-full bg-bg-card border border-border rounded px-2 py-1 text-fg outline-none focus:border-brand resize-y" placeholder="Text" />)}
                {sel.kind === "text" && (
                  <div className="space-y-1">
                    <div className="text-fg-muted">Entrance animation</div>
                    <div className="grid grid-cols-4 gap-1">
                      {([["", "None"], ["fade", "Fade"], ["scale", "Scale"], ["zoomIn", "Zoom in"], ["bounce", "Bounce"], ["spin", "Spin"], ["slideUp", "Slide ↑"], ["slideDown", "Slide ↓"], ["wipeRight", "Wipe →"], ["wipeLeft", "Wipe ←"], ["blurIn", "Blur"], ["wordsUp", "Words up"], ["typewriter", "Type"]] as const).map(([v, l]) => (
                        <button key={v} onClick={() => { const ids = selectedRef.current.length > 1 ? new Set(selectedRef.current) : new Set([sel.id]); setClips((p) => p.map((c) => (c.kind === "text" && ids.has(c.id) ? { ...c, tstyle: { ...(c.tstyle || {}), enter: v as TextStyle["enter"] } } : c))); }}
                          className={`px-1 py-1 rounded border text-[10px] ${(sel.tstyle?.enter || "") === v ? "border-brand bg-brand/10 text-brand" : "border-border text-fg-muted hover:border-brand/50"}`}>{l}</button>
                      ))}
                    </div>
                    <div className="text-fg-muted pt-1">Exit animation</div>
                    <div className="grid grid-cols-4 gap-1">
                      {([["", "None"], ["fade", "Fade"], ["scale", "Scale"], ["zoomOut", "Zoom out"], ["slideUp", "Slide ↑"], ["slideDown", "Slide ↓"], ["wipeLeft", "Wipe ←"], ["wipeRight", "Wipe →"], ["blurOut", "Blur"]] as const).map(([v, l]) => (
                        <button key={v} onClick={() => { const ids = selectedRef.current.length > 1 ? new Set(selectedRef.current) : new Set([sel.id]); setClips((p) => p.map((c) => (c.kind === "text" && ids.has(c.id) ? { ...c, tstyle: { ...(c.tstyle || {}), exit: v as TextStyle["exit"] } } : c))); }}
                          className={`px-1 py-1 rounded border text-[10px] ${(sel.tstyle?.exit || "") === v ? "border-brand bg-brand/10 text-brand" : "border-border text-fg-muted hover:border-brand/50"}`}>{l}</button>
                      ))}
                    </div>
                    <div className="text-fg-muted pt-1">Loop</div>
                    <div className="grid grid-cols-4 gap-1">
                      {([["", "None"], ["pulse", "Pulse"], ["float", "Float"], ["wiggle", "Wiggle"]] as const).map(([v, l]) => (
                        <button key={v} onClick={() => { const ids = selectedRef.current.length > 1 ? new Set(selectedRef.current) : new Set([sel.id]); setClips((p) => p.map((c) => (c.kind === "text" && ids.has(c.id) ? { ...c, tstyle: { ...(c.tstyle || {}), loop: v as TextStyle["loop"] } } : c))); }}
                          className={`px-1 py-1 rounded border text-[10px] ${(sel.tstyle?.loop || "") === v ? "border-brand bg-brand/10 text-brand" : "border-border text-fg-muted hover:border-brand/50"}`}>{l}</button>
                      ))}
                    </div>
                    <div className="text-[10px] text-fg-subtle">Full styling (colors, plates, fonts, presets): <b>Captions → Caption style</b>.</div>
                  </div>
                )}
                {sel.kind === "fx" && (<select value={sel.fx} onChange={(e) => update(sel.id, { fx: e.target.value })} className="w-full bg-bg-card border border-border rounded px-2 py-1 text-fg outline-none">{FX.map((f) => <option key={f.v} value={f.v}>{f.l}</option>)}</select>)}
                {sel.kind === "adjust" && (<select value={sel.fx} onChange={(e) => update(sel.id, { fx: e.target.value })} className="w-full bg-bg-card border border-border rounded px-2 py-1 text-fg outline-none">{ADJUST.map((f) => <option key={f.v} value={f.v}>{f.l}</option>)}</select>)}
              </div>

              <div className="space-y-1.5">
                <div className="text-fg-muted font-medium">Timing</div>
                <div className="grid grid-cols-2 gap-1.5">
                  <label className="flex items-center gap-1 text-fg-muted">start<input type="number" min={0} step={0.1} value={sel.start} onChange={(e) => update(sel.id, { start: Math.max(0, Number(e.target.value) || 0) })} className="flex-1 min-w-0 bg-bg-card border border-border rounded px-1.5 py-1 text-fg outline-none focus:border-brand" /></label>
                  <label className="flex items-center gap-1 text-fg-muted">dur<input type="number" min={MIN_DUR} step={0.1} value={sel.duration} onChange={(e) => update(sel.id, { duration: Math.max(MIN_DUR, Number(e.target.value) || MIN_DUR) })} className="flex-1 min-w-0 bg-bg-card border border-border rounded px-1.5 py-1 text-fg outline-none focus:border-brand" /></label>
                  <label className="flex items-center gap-1 text-fg-muted">fade in<input type="number" min={0} step={0.1} value={sel.fadeIn} onChange={(e) => update(sel.id, { fadeIn: Math.max(0, Number(e.target.value) || 0) })} className="flex-1 min-w-0 bg-bg-card border border-border rounded px-1.5 py-1 text-fg outline-none focus:border-brand" /></label>
                  <label className="flex items-center gap-1 text-fg-muted">fade out<input type="number" min={0} step={0.1} value={sel.fadeOut} onChange={(e) => update(sel.id, { fadeOut: Math.max(0, Number(e.target.value) || 0) })} className="flex-1 min-w-0 bg-bg-card border border-border rounded px-1.5 py-1 text-fg outline-none focus:border-brand" /></label>
                </div>
              </div>

              {(sel.kind === "video" || sel.kind === "image" || sel.kind === "text") && (
                <div className="space-y-1.5">
                  <div className="text-fg-muted font-medium">Transform & motion</div>
                  <label className="flex items-center gap-2 text-fg-muted">scale<input type="range" min={0.2} max={3} step={0.05} value={sel.scale} onChange={(e) => updateSel(sel.id, { scale: Number(e.target.value) })} className="flex-1" /><span className="w-9 text-right tabular-nums">{Math.round(sel.scale * 100)}%</span></label>
                  <label className="flex items-center gap-2 text-fg-muted">animation<select value={sel.anim ?? ""} onChange={(e) => update(sel.id, { anim: e.target.value })} className="flex-1 bg-bg-card border border-border rounded px-1.5 py-1 text-fg outline-none">{ANIMS.map((a) => <option key={a.v} value={a.v}>{a.l}</option>)}</select></label>
                  <button onClick={() => resetTransform(sel.id)} className="text-[10px] text-fg-subtle hover:text-fg underline underline-offset-2">Reset position & scale</button>
                </div>
              )}

              {(sel.kind === "video" || sel.kind === "image") && (
                <div className="space-y-1.5">
                  <div className="text-fg-muted font-medium">Blend & background</div>
                  <label className="flex items-center gap-2 text-fg-muted">blend
                    <select value={sel.blend ?? ""} onChange={(e) => updateSel(sel.id, { blend: e.target.value })} className="flex-1 bg-bg-card border border-border rounded px-1.5 py-1 text-fg outline-none">
                      <option value="">Normal</option>
                      <option value="screen">Screen — drop black bg</option>
                      <option value="multiply">Multiply — drop white bg</option>
                    </select>
                  </label>
                  <div className="flex items-center gap-1.5 text-fg-muted">
                    <span>chroma key</span>
                    <button onClick={() => updateSel(sel.id, { keyColor: "#00ff00" })} className={`px-1.5 py-0.5 rounded border text-[10px] ${sel.keyColor === "#00ff00" ? "border-brand text-brand" : "border-border"}`}>Green</button>
                    <button onClick={() => updateSel(sel.id, { keyColor: "#0000ff" })} className={`px-1.5 py-0.5 rounded border text-[10px] ${sel.keyColor === "#0000ff" ? "border-brand text-brand" : "border-border"}`}>Blue</button>
                    <input type="color" value={sel.keyColor ?? "#00ff00"} onChange={(e) => updateSel(sel.id, { keyColor: e.target.value })} className="w-6 h-6 p-0 border border-border rounded bg-transparent" title="Custom key color" />
                    <button onClick={() => updateSel(sel.id, { keyColor: undefined, keyTol: undefined })} className={`px-1.5 py-0.5 rounded border text-[10px] ${!sel.keyColor ? "border-brand text-brand" : "border-border"}`}>Off</button>
                  </div>
                  {sel.keyColor && (
                    <label className="flex items-center gap-2 text-fg-muted">tolerance<input type="range" min={0.05} max={0.8} step={0.01} value={sel.keyTol ?? 0.3} onChange={(e) => updateSel(sel.id, { keyTol: Number(e.target.value) })} className="flex-1" /><span className="w-8 text-right tabular-nums">{Math.round((sel.keyTol ?? 0.3) * 100)}%</span></label>
                  )}
                  <div className="text-[10px] text-fg-subtle">Transparent PNG and alpha WebM work as-is. For footage on a solid color use chroma key; for glows/fireworks on black use Screen.</div>
                  {/* Screen track — pin this clip onto a green-screen phone screen (live corner-pin). */}
                  <div className="border-t border-border pt-2 mt-1 space-y-1.5">
                    <div className="flex items-center gap-1.5 text-fg-muted">
                      <span className="whitespace-nowrap">screen track</span>
                      <select value={sel.trackTo ?? ""} onChange={(e) => updateSel(sel.id, { trackTo: e.target.value || undefined })} className="flex-1 bg-bg-card border border-border rounded px-1.5 py-1 text-fg outline-none text-[11px]">
                        <option value="">Off</option>
                        {clips.filter((c) => c.kind === "video" && c.id !== sel.id && c.url).map((c) => (
                          <option key={c.id} value={c.id}>{c.label}</option>
                        ))}
                      </select>
                    </div>
                    {sel.trackTo && (() => {
                      const phone = clips.find((c) => c.id === sel.trackTo);
                      const trk = phone?.url ? trackCache[phone.url] : null;
                      const status = trk === "loading" ? "tracking…" : trk === "error" ? "track failed" : trk ? "tracked ✓" : "—";
                      return (
                        <div className="space-y-1.5">
                          <div className="text-[10px] text-fg-subtle">Source: <b>{phone?.label ?? "?"}</b> · {status}</div>
                          <button type="button" onClick={() => setTrackOpen(true)} disabled={!trk || typeof trk === "string"} className="w-full px-2 py-1.5 rounded-md bg-brand text-white text-[11px] font-medium disabled:opacity-50 inline-flex items-center justify-center gap-1.5">
                            <SlidersHorizontal size={13} /> Adjust track
                          </button>
                          <div className="text-[10px] text-fg-subtle leading-snug">Content warps onto the phone screen live. Put the green-screen clip on a layer ABOVE this one with chroma-key on, so fingers stay on top.</div>
                        </div>
                      );
                    })()}
                  </div>
                </div>
              )}

              {(sel.kind === "video" || sel.kind === "audio") && (
                <div className="space-y-1.5">
                  <div className="text-fg-muted font-medium">Audio</div>
                  <label className="flex items-center gap-2 text-fg-muted">volume<input type="range" min={0} max={2} step={0.05} value={sel.volume ?? 1} onChange={(e) => updateSel(sel.id, { volume: Number(e.target.value) })} disabled={!!sel.muted} className="flex-1 disabled:opacity-40" /><span className="w-10 text-right tabular-nums">{Math.round((sel.volume ?? 1) * 100)}%</span></label>
                  <label className="flex items-center gap-1.5 text-fg-muted"><input type="checkbox" checked={!!sel.muted} onChange={(e) => updateSel(sel.id, { muted: e.target.checked })} /> Mute</label>
                </div>
              )}
            </div>
          )}
        </div>
      </aside>

      {/* Context menu */}
      {menu && (() => {
        const c = clips.find((x) => x.id === menu.id);
        if (!c) return null;
        const apply = (patch: Partial<EditClip>) => { update(menu.id, patch); setMenu(null); };
        const isMedia = c.kind === "video" || c.kind === "image" || c.kind === "text";
        return (
          <div className="fixed z-50 w-52 bg-bg-card border border-border rounded-lg shadow-xl p-1.5 text-[11px]" style={{ left: Math.min(menu.x, window.innerWidth - 220), top: Math.max(8, Math.min(menu.y, window.innerHeight - 500)) }} onClick={(e) => e.stopPropagation()}>
            {isMedia && (
              <>
                <div className="px-1.5 py-1 text-fg-subtle uppercase tracking-wider text-[9px]">Animation</div>
                <div className="grid grid-cols-2 gap-1 px-1 pb-1.5">
                  {ANIMS.map((a) => (<button key={a.v} onClick={() => apply({ anim: a.v })} className={`px-1.5 py-1 rounded text-left ${(c.anim ?? "") === a.v ? "bg-brand/20 text-brand" : "hover:bg-white/5 text-fg-muted"}`}>{a.l}</button>))}
                </div>
              </>
            )}
            <div className="px-1.5 py-1 text-fg-subtle uppercase tracking-wider text-[9px]">Fade</div>
            <div className="grid grid-cols-2 gap-1 px-1 pb-1.5">
              <button onClick={() => apply({ fadeIn: 0.5 })} className="px-1.5 py-1 rounded hover:bg-white/5 text-fg-muted text-left">In 0.5s</button>
              <button onClick={() => apply({ fadeOut: 0.5 })} className="px-1.5 py-1 rounded hover:bg-white/5 text-fg-muted text-left">Out 0.5s</button>
              <button onClick={() => apply({ fadeIn: 0.5, fadeOut: 0.5 })} className="px-1.5 py-1 rounded hover:bg-white/5 text-fg-muted text-left">Both 0.5s</button>
              <button onClick={() => apply({ fadeIn: 0, fadeOut: 0 })} className="px-1.5 py-1 rounded hover:bg-white/5 text-fg-muted text-left">None</button>
            </div>
            <div className="border-t border-border my-1" />
            {isMedia && <button onClick={() => { resetTransform(menu.id); setMenu(null); }} className="w-full px-1.5 py-1.5 rounded hover:bg-white/5 text-fg-muted text-left inline-flex items-center gap-2"><Clapperboard size={12} /> Reset transform</button>}
            <button onClick={() => { duplicate(menu.id); setMenu(null); }} className="w-full px-1.5 py-1.5 rounded hover:bg-white/5 text-fg-muted text-left inline-flex items-center gap-2"><Copy size={12} /> Duplicate</button>
            <button onClick={() => { remove(menu.id); setMenu(null); }} className="w-full px-1.5 py-1.5 rounded hover:bg-red-500/10 text-red-400 text-left inline-flex items-center gap-2"><Trash2 size={12} /> Delete</button>
          </div>
        );
      })()}

      {/* Transition popover (from the "+" between clips) */}
      {transMenu && (() => {
        const b = clips.find((x) => x.id === transMenu.id);
        return (
          <div className="fixed z-50 w-44 bg-bg-card border border-border rounded-lg shadow-xl p-1.5 text-[11px]" style={{ left: Math.min(transMenu.x, window.innerWidth - 190), top: Math.max(8, Math.min(transMenu.y, window.innerHeight - 320)) }} onClick={(e) => e.stopPropagation()}>
            <div className="px-1.5 py-1 text-fg-subtle uppercase tracking-wider text-[9px]">Transition</div>
            <div className="grid grid-cols-2 gap-1 px-1 pb-1">
              {TRANSITIONS.map((a) => (
                <button key={a.v} onClick={() => applyTransition(transMenu.id, a.v)} className={`px-1.5 py-1 rounded text-left ${(b?.transType ?? "") === a.v ? "bg-amber-400/20 text-amber-300" : "hover:bg-white/5 text-fg-muted"}`}>{a.l}</button>
              ))}
            </div>
          </div>
        );
      })()}
      {marquee && marquee.w > 1 && marquee.h > 1 && (
        <div className="fixed z-50 border border-brand bg-brand/15 pointer-events-none" style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }} />
      )}
      {trackOpen && sel && sel.trackTo && (() => {
        const phone = clips.find((c) => c.id === sel.trackTo);
        if (!phone?.url) return null;
        return (
          <TrackEditor
            source={phone.url}
            value={sel.trackKeys ?? []}
            initialMode={sel.trackMode}
            onSave={(keys, mode) => updateSel(sel.id, { trackKeys: keys, trackMode: mode })}
            onClose={() => setTrackOpen(false)}
          />
        );
      })()}
    </div>
  );
}
