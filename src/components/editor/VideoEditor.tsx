"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { alphaAt, clipVisual, TRANSITIONS, type CompClip } from "@/lib/editor/compositor";
import { LLM_MODELS } from "@/lib/canvas/types";
import type { TextStyle, CapWord } from "@/lib/editor/exportVideo";
import { drawCaption, kfState, type ExportClip } from "@/lib/editor/exportVideo";
import {
  Music, Type, Plus, Trash2, Play, Pause, SkipBack,
  Download, Clapperboard, ZoomIn, ZoomOut, Loader2, Sparkles, Copy, Wand2,
  Scissors, Eye, EyeOff, Lock, Unlock, Folder, Subtitles, SlidersHorizontal, RefreshCw, ChevronDown, ChevronLeft, ChevronRight, Tag, X, Layers,
} from "lucide-react";
import TrackEditor from "@/components/canvas/TrackEditor";

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
  // Dominant channel of the key (green for a green screen, blue for blue).
  const kmax = Math.max(kr, kg, kb);
  const dom = kr === kmax ? 0 : kg === kmax ? 1 : 2;
  const tolN = Math.max(0.02, Math.min(1, keyTol));
  // (1) distance to the exact key color — removes the clean key shade.
  const distTol = tolN * 255 * 1.5, distSoft = distTol * 0.4;
  // (2) channel dominance — a pixel counts as key when the key channel exceeds
  //     the OTHER two by a margin, regardless of brightness. This is what
  //     catches dark / shadowed / uneven greens that a single-colour distance
  //     test misses. Looser tolerance → smaller required margin.
  const domThresh = Math.round((1 - tolN) * 50);
  const domSoft = 38;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    const dr = r - kr, dg = g - kg, db = b - kb;
    const dist = Math.sqrt(dr * dr + dg * dg + db * db);
    const aDist = dist < distTol ? 0 : dist < distTol + distSoft ? (dist - distTol) / distSoft : 1;
    const ch = dom === 0 ? r : dom === 1 ? g : b;
    const o1 = dom === 0 ? g : r;
    const o2 = dom === 2 ? g : b;
    const margin = ch - Math.max(o1, o2); // >0 when the key channel dominates
    const aDom = margin > domThresh + domSoft ? 0 : margin > domThresh ? 1 - (margin - domThresh) / domSoft : 1;
    const a = Math.min(aDist, aDom); // transparent if EITHER test says so
    if (a < 1) d[i + 3] = Math.round(d[i + 3] * a);
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
type SRTrackKey = { t: number; c: number[][] };
type SRTrackMode = "region" | "keys" | "anchor";
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
  fit?: "cover" | "contain" | "blur"; // how media adapts to the canvas aspect
  rot?: number; // rotation in degrees (media clips)
  kf?: { t: number; x?: number; y?: number; scale?: number; rot?: number }[]; // transform keyframes (clip-local time)
  // Alternatives for batch "versions": extra options beyond this clip's base
  // value. Each version swaps in one option's text (captions) or url (media).
  variants?: { id: string; text?: string; url?: string; dur?: number }[];
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
  // Server-rendered screen replace (node-quality): green source + content + track.
  sr?: {
    green: string; content?: string; contentVideo?: boolean;
    key?: string; sim?: number; fit?: "fill" | "cover";
    matte?: number; feather?: number; scaleX?: number; scaleY?: number;
    keys?: SRTrackKey[]; mode?: SRTrackMode;
  };
};

const RESOLUTIONS = [
  { key: "9:16", label: "Portrait 9:16", w: 1080, h: 1920 },
  { key: "4:5", label: "Portrait 4:5", w: 1080, h: 1350 },
  { key: "16:9", label: "Landscape 16:9", w: 1920, h: 1080 },
  { key: "1:1", label: "Square 1:1", w: 1080, h: 1080 },
];
const DEFAULTS = { image: 4, audio: 6, video: 4, text: 3, fx: 1.5, adjust: 3 };
// Export filename templating. Tokens: {project} {type} {version} {resolution}
// {duration} {lang} {initials}. "__" separates the concept block from render
// specs (matches the team's CCA naming convention). Persisted per browser.
const NAMING_KEY = "flowlab.editor.naming";
const NAMING_DEFAULT = { template: "{date}_{brand}_{project}_{type}_{version}__{resolution}_{duration}_{lang}_{initials}", version: "v1", lang: "en", initials: "", brandCode: "" };
// {date} = YY.MM, e.g. 26.07
function namingDate(): string {
  const d = new Date();
  return `${String(d.getFullYear() % 100).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}`;
}
// Default brand abbreviation: initials of words ("Cleaner Kit" -> CK), else
// the first two letters upper-cased. The codes in the studio's sheet are not
// fully rule-based (Ringtune -> RT), so the field stays editable.
function guessBrandCode(name?: string): string {
  if (!name) return "";
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return words.slice(0, 3).map((w) => w[0]).join("").toUpperCase();
  return name.trim().slice(0, 2).toUpperCase();
}
const NAMING_TOKENS = ["date", "brand", "project", "type", "version", "resolution", "duration", "lang", "initials"] as const;
// Versions = cartesian product of each variant slot's options (option 0 = base).
// ---- Timeline versions -------------------------------------------------------
// A version is a FULL snapshot of the timeline (clips + layers). You edit one
// version at a time; the tabs simply switch which snapshot is loaded into the
// editor. Everything you can do on the timeline (add, replace, delete, trim,
// text, transitions) just works per version.
export type TLSnapshot = { id: string; name: string; clips: EditClip[]; layers: Layer[] };

// Keep hook/body/packshot chained back-to-back. Pure: returns the SAME array
// when nothing needs to move (so effects can call it without loops).
const SECTION_ORDER = ["Hook", "Body", "Packshot", "CTA"];
function chainSections(list: EditClip[]): EditClip[] {
  const sec = list.filter((c) => c.section);
  if (!sec.length) return list;
  const names = Array.from(new Set(sec.map((c) => c.section as string)))
    .sort((a, b) => (SECTION_ORDER.indexOf(a) === -1 ? 99 : SECTION_ORDER.indexOf(a)) - (SECTION_ORDER.indexOf(b) === -1 ? 99 : SECTION_ORDER.indexOf(b)));
  let cursor = 0;
  const startBy = new Map<string, number>();
  for (const name of names) {
    startBy.set(name, cursor);
    const span = Math.max(...sec.filter((c) => c.section === name && (c.kind === "video" || c.kind === "image")).map((c) => c.duration), 1);
    cursor = +(cursor + span).toFixed(3);
  }
  let changed = false;
  const out = list.map((c) => {
    if (!c.section || !startBy.has(c.section)) return c;
    const st = startBy.get(c.section)!;
    if (Math.abs(c.start - st) < 0.002) return c;
    changed = true;
    return { ...c, start: st };
  });
  return changed ? out : list;
}
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

// Collapsible grouped section for the Properties panel (Apple/iOS-settings feel):
// a rounded hairline group with a tappable header (title + chevron + optional
// right slot) and a body that collapses. Presentational — open state lives in
// the editor so it persists across re-renders.
function Section({ id, title, open, onToggle, right, children }: {
  id: string; title: string; open: boolean; onToggle: (id: string) => void;
  right?: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <div className="surface r-md overflow-hidden" style={{ boxShadow: "none" }}>
      <div className="flex items-center justify-between gap-2 px-2.5 py-2">
        <button type="button" onClick={() => onToggle(id)} className="flex items-center gap-1.5 text-fg font-medium text-[12px] min-w-0 flex-1 text-left">
          <ChevronDown size={13} className={`shrink-0 text-fg-subtle transition-transform ${open ? "" : "-rotate-90"}`} />
          <span className="truncate">{title}</span>
        </button>
        {right}
      </div>
      {open && <div className="px-2.5 pb-2.5 space-y-2">{children}</div>}
    </div>
  );
}

// ---- video thumbnails without live <video> elements --------------------------
// Every bin card / picker tile used to mount its own network-backed <video>
// (preload=metadata). Dozens of parallel range requests saturated the
// connection: thumbnails never finished, and a hidden tab froze mid-load.
// VideoThumb instead grabs ONE frame per URL through a small work queue
// (3 downloads at a time), caches it as a data-URL for the whole session and
// renders a plain <img>. A live video is mounted only while hovered.
const frameCache = new Map<string, { img: string | null; dur: number; w: number; h: number; live?: boolean }>();
// Captured frames persist across sessions (localStorage, ~2.3MB budget), so
// the bin is instant on revisit instead of re-downloading every video.
let thumbStoreLoaded = false;
let thumbSaveTimer: ReturnType<typeof setTimeout> | null = null;
function loadThumbStore() {
  if (thumbStoreLoaded || typeof window === "undefined") return;
  thumbStoreLoaded = true;
  try {
    const raw = localStorage.getItem("flowlab.thumbs.v1");
    if (!raw) return;
    const j = JSON.parse(raw) as Record<string, { img: string; dur: number; w: number; h: number }>;
    for (const [u, v] of Object.entries(j)) if (v?.img && !frameCache.has(u)) frameCache.set(u, v);
  } catch { /* corrupt store */ }
}
function scheduleThumbSave() {
  if (typeof window === "undefined") return;
  if (thumbSaveTimer) clearTimeout(thumbSaveTimer);
  thumbSaveTimer = setTimeout(() => {
    try {
      const out: Record<string, { img: string; dur: number; w: number; h: number }> = {};
      let size = 0;
      const entries = Array.from(frameCache.entries()).filter(([, v]) => v.img && !v.live);
      for (let i = entries.length - 1; i >= 0; i--) { // newest first
        const [u, v] = entries[i];
        size += v.img!.length;
        if (size > 2_300_000) break;
        out[u] = { img: v.img!, dur: v.dur, w: v.w, h: v.h };
      }
      localStorage.setItem("flowlab.thumbs.v1", JSON.stringify(out));
    } catch { /* quota - skip silently */ }
  }, 1500);
}
const framePending = new Map<string, Promise<{ img: string | null; dur: number; w: number; h: number; live?: boolean } | null>>();
let frameActive = 0;
const frameQueue: (() => void)[] = [];
function framePump() {
  while (frameActive < 3 && frameQueue.length) { frameActive++; frameQueue.shift()!(); }
}
function grabFrame(url: string): Promise<{ img: string | null; dur: number; w: number; h: number; live?: boolean } | null> {
  loadThumbStore();
  const hit = frameCache.get(url);
  if (hit) return Promise.resolve(hit);
  const pending = framePending.get(url);
  if (pending) return pending;
  const p = new Promise<{ img: string | null; dur: number; w: number; h: number; live?: boolean } | null>((resolve) => {
    const attempt = (useCors: boolean) => {
      const v = document.createElement("video");
      if (useCors) v.crossOrigin = "anonymous";
      v.muted = true; v.playsInline = true;
      v.preload = "auto"; // metadata alone never buffers a drawable frame
      let done = false;
      const finish = (res: { img: string | null; dur: number; w: number; h: number; live?: boolean } | null, retryNoCors?: boolean) => {
        if (done) return; done = true;
        clearTimeout(tm);
        try { v.removeAttribute("src"); v.load(); } catch { /* */ }
        if (retryNoCors) { attempt(false); return; }
        frameActive--; framePump();
        if (res) { frameCache.set(url, res); if (res.img) scheduleThumbSave(); }
        framePending.delete(url);
        resolve(res);
      };
      const tm = setTimeout(() => finish(useCors ? null : { img: null, dur: 0, w: 0, h: 0, live: true }, useCors), 10_000);
      v.onerror = () => finish(useCors ? null : { img: null, dur: 0, w: 0, h: 0, live: true }, useCors);
      v.onloadedmetadata = () => { try { v.currentTime = Math.min(0.1, (v.duration || 1) / 2); } catch { finish(null, useCors); } };
      v.onseeked = () => {
        try {
          const scale = 200 / Math.max(v.videoWidth, v.videoHeight, 1);
          const c = document.createElement("canvas");
          c.width = Math.max(2, Math.round(v.videoWidth * scale));
          c.height = Math.max(2, Math.round(v.videoHeight * scale));
          c.getContext("2d")!.drawImage(v, 0, 0, c.width, c.height);
          finish({ img: c.toDataURL("image/jpeg", 0.72), dur: v.duration || 0, w: v.videoWidth, h: v.videoHeight });
        } catch {
          // tainted canvas (no CORS headers): remember dims, render a lazy
          // live <video> tile instead of a captured frame
          finish({ img: null, dur: v.duration || 0, w: v.videoWidth, h: v.videoHeight, live: true });
        }
      };
      v.src = url;
    };
    frameQueue.push(() => attempt(true)); framePump();
  });
  framePending.set(url, p);
  return p;
}
function VideoThumb({ src, className, hoverPlay, onDims }: { src: string; className?: string; hoverPlay?: boolean; onDims?: (w: number, h: number, dur: number) => void }) {
  loadThumbStore();
  const holdRef = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<{ img: string | null; live: boolean } | null>(() => {
    const c = frameCache.get(src); return c ? { img: c.img, live: !!c.live } : null;
  });
  const [hover, setHover] = useState(false);
  useEffect(() => {
    const c0 = frameCache.get(src);
    setState(c0 ? { img: c0.img, live: !!c0.live } : null);
    if (c0) { onDims?.(c0.w, c0.h, c0.dur); return; }
    const el = holdRef.current;
    if (!el) return;
    let alive = true;
    const io = new IntersectionObserver((es) => {
      if (!es.some((e) => e.isIntersecting)) return;
      io.disconnect();
      grabFrame(src).then((r) => { if (alive && r) { setState({ img: r.img, live: !!r.live }); if (r.w) onDims?.(r.w, r.h, r.dur); } });
    }, { rootMargin: "160px" });
    io.observe(el);
    return () => { alive = false; io.disconnect(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);
  return (
    <div ref={holdRef} className={`relative overflow-hidden ${className ?? ""}`}
      onMouseEnter={hoverPlay ? () => setHover(true) : undefined}
      onMouseLeave={hoverPlay ? () => setHover(false) : undefined}>
      {state?.img
        // eslint-disable-next-line @next/next/no-img-element
        ? <img src={state.img} alt="" draggable={false} className="absolute inset-0 w-full h-full object-cover" />
        : state?.live
          ? <video src={src} muted playsInline preload="metadata" className="absolute inset-0 w-full h-full object-cover" />
          : <div className="absolute inset-0 grid place-items-center bg-bg-subtle/40"><span className="w-3.5 h-3.5 rounded-full border border-border border-t-brand animate-spin" /></div>}
      {hover && <video src={src} muted loop playsInline autoPlay className="absolute inset-0 w-full h-full object-cover" />}
    </div>
  );
}

export default function VideoEditor({ assets, workflowId, projectId, projectName, brandId, brandName }: { assets: EditorAsset[]; workflowId?: string; projectId?: string; projectName?: string; brandId?: string; brandName?: string }) {
  const [layers, setLayers] = useState<Layer[]>([{ id: "v1", type: "video" }, { id: "a1", type: "audio" }]);
  const [selectedLayer, setSelectedLayer] = useState<string | null>(null);
  const [renamingLayer, setRenamingLayer] = useState<string | null>(null);
  const [clips, setClips] = useState<EditClip[]>([]);
  const [trackOpen, setTrackOpen] = useState(false);
  const [srBusy, setSrBusy] = useState(false);
  const [srErr, setSrErr] = useState<string | null>(null);
  const [srPicker, setSrPicker] = useState(false);
  const [srTrackCache, setSrTrackCache] = useState<Record<string, { fps: number; w: number; h: number; quads: number[][][] } | "loading" | "error">>({});
  const [openSec, setOpenSec] = useState<Record<string, boolean>>({ basic: true, timing: true, transform: true, background: true, sr: true, audio: true });
  const toggleSec = (id: string) => setOpenSec((s) => ({ ...s, [id]: !s[id] }));
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const selected = selectedIds.length ? selectedIds[selectedIds.length - 1] : null;
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const marqueeRef = useRef<{ x0: number; y0: number } | null>(null);
  const [binFilter, setBinFilter] = useState<"all" | "video" | "image" | "audio">("all");
  const [library, setLibrary] = useState<EditorAsset[]>(assets.filter((a) => !/\.(json|txt|srt|vtt|csv)(\?|$)/i.test(a.url)));
  const [binQuery, setBinQuery] = useState("");
  const [binBrand, setBinBrand] = useState(brandId ?? ""); // default: the project's brand (dropdown switches to All)
  const [binProject, setBinProject] = useState(projectId ?? "");
  const [binSource, setBinSource] = useState("");
  // Assets that came through "Send to editor" but did not land on the
  // timeline (alternate hooks/bodies...). Kept SEPARATE from `library`
  // because loadGen() rebuilds `library` from the assets API and would wipe
  // them. Persisted per project.
  const [canvasAssets, setCanvasAssets] = useState<EditorAsset[]>(() => {
    try {
      const raw = localStorage.getItem(`${PROJECT_KEY}:canvasAssets`);
      const j = raw ? (JSON.parse(raw) as EditorAsset[]) : [];
      return Array.isArray(j) ? j.slice(0, 60) : [];
    } catch { return []; }
  });
  useEffect(() => {
    try { localStorage.setItem(`${PROJECT_KEY}:canvasAssets`, JSON.stringify(canvasAssets.slice(0, 60))); } catch { /* */ }
  }, [canvasAssets]);
  // Alternates that just arrived from the canvas -> loud banner over the
  // preview offering to build every combination as versions.
  const [altNotice, setAltNotice] = useState<EditorAsset[] | null>(null);
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
  // Per-format layout overrides: layouts[formatKey][clipId] = { x, y, scale }.
  // The live `clips` hold the ACTIVE format's layout; `layouts` snapshots the
  // other formats so switching remembers each one's framing.
  const [layouts, setLayouts] = useState<Record<string, Record<string, { x: number; y: number; scale: number }>>>({});
  const layoutsRef = useRef<Record<string, Record<string, { x: number; y: number; scale: number }>>>({});
  layoutsRef.current = layouts;
  // Legacy projects stored x/y in preview px; migrate them to canvas fractions
  // once the preview is measured (see the migration effect below).
  const legacyPosRef = useRef(false);
  const posMigratedRef = useRef(false);
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
  const statusSeqRef = useRef(0);
  // Transient notice: shows a status line and clears it after a few seconds
  // (unless something else overwrote it in the meantime).
  const flashStatus = useCallback((msg: string, ms = 4000) => {
    const seq = ++statusSeqRef.current;
    setStatus(msg);
    setTimeout(() => { if (statusSeqRef.current === seq) setStatus(""); }, ms);
  }, []);
  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [namingOpen, setNamingOpen] = useState(false);
  const [naming, setNaming] = useState<{ template: string; version: string; lang: string; initials: string; brandCode?: string }>(() => {
    if (typeof window !== "undefined") {
      try { const raw = localStorage.getItem(NAMING_KEY); if (raw) return { ...NAMING_DEFAULT, ...JSON.parse(raw) }; } catch { /* */ }
    }
    return NAMING_DEFAULT;
  });
  useEffect(() => { try { localStorage.setItem(NAMING_KEY, JSON.stringify(naming)); } catch { /* */ } }, [naming]);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [genClip, setGenClip] = useState(""); // versions generator: clip to replace
  const [genCat, setGenCat] = useState("hook"); // versions generator: bin category
  const [replaceFor, setReplaceFor] = useState<string | null>(null); // clip id being replaced in the active version
  const [batchRunning, setBatchRunning] = useState(false);
  const [batchFormats, setBatchFormats] = useState<Set<string>>(() => new Set(["9:16"]));
  const [hookBannerDismissed, setHookBannerDismissed] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const [dropHint, setDropHint] = useState<{ type: "lane" | "strip"; id: string } | null>(null);
  const [cutMode, setCutMode] = useState(false); // scissors tool: click a clip to split it at the cursor
  const cutModeRef = useRef(false);
  cutModeRef.current = cutMode;
  const [binDragging, setBinDragging] = useState(false); // an asset is being dragged from the bin
  const [clipDragging, setClipDragging] = useState(false); // a timeline clip is being moved
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
    for (const a of [...canvasAssets, ...library, ...brandLib]) {
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

  // ---- Version preview -----------------------------------------------------
  // Timeline versions are full snapshots; the active one is loaded into
  // clips/layers and edited directly. Switching tabs stores the current state
  // back into the snapshot list and loads the target.
  const [tlVersions, setTlVersions] = useState<TLSnapshot[]>([]);
  const [activeVer, setActiveVer] = useState(0); // index into tlVersions (single implicit version while the list is empty)
  const viewClips = clips; // the loaded version IS the editable timeline
  const viewClipsRef = useRef<EditClip[]>([]);
  viewClipsRef.current = viewClips;
  const tlVersionsRef = useRef<TLSnapshot[]>([]);
  tlVersionsRef.current = tlVersions;
  const activeVerRef = useRef(0);
  activeVerRef.current = activeVer;
  // Store the live editor state back into the active snapshot.
  const syncedVersions = useCallback((): TLSnapshot[] => {
    const vs = tlVersionsRef.current;
    if (!vs.length) return [];
    const cur = Math.min(activeVerRef.current, vs.length - 1);
    return vs.map((v, k) => (k === cur ? { ...v, clips: clipsRef.current, layers: layersRef.current } : v));
  }, []);

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
  const mediaBin = sortBin([...canvasAssets.filter((a) => !library.some((l) => l.url === a.url)), ...library].filter((a) => (binFilter === "all" || a.kind === binFilter) && matchAspect(a)));
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
        if (!a.cdnUrl || seen.has(a.cdnUrl)) continue; if (!(a.kind === "video" || a.kind === "image" || a.kind === "audio")) continue; if (/\.(json|txt|srt|vtt|csv)(\?|$)/i.test(a.cdnUrl)) continue;
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
    // Restore the saved project first (if any) — a canvas hand-off is MERGED
    // on top of it as new layers instead of wiping the whole assembly.
    let savedClips: EditClip[] = [];
    let savedLayers: Layer[] = [];
    try {
      const raw = localStorage.getItem(PROJECT_KEY);
      if (raw) {
        const j = JSON.parse(raw) as { clips?: EditClip[]; layers?: Layer[]; resKey?: string; posMode?: string; layouts?: Record<string, Record<string, { x: number; y: number; scale: number }>>; versions?: TLSnapshot[]; activeVer?: number };
        if (Array.isArray(j.clips) && j.clips.length && Array.isArray(j.layers) && j.layers.length) {
          legacyPosRef.current = j.posMode !== "frac";
          savedClips = j.clips; savedLayers = j.layers;
          if (j.layouts && typeof j.layouts === "object") setLayouts(j.layouts);
          if (j.resKey && RESOLUTIONS.some((r) => r.key === j.resKey)) setResKey(j.resKey);
          const vers = Array.isArray(j.versions) ? j.versions.filter((v) => v && typeof v === "object" && Array.isArray(v.clips) && Array.isArray(v.layers)) : [];
          if (vers.length) {
            const ai = Math.min(Math.max(0, j.activeVer ?? 0), vers.length - 1);
            setTlVersions(vers);
            setActiveVer(ai);
            savedClips = vers[ai].clips; savedLayers = vers[ai].layers;
          }
        }
      }
    } catch { /* ignore corrupt saves */ }
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
          let sharedSectionVideoLayer: string | null = null;
          let sharedSectionAudioLayer: string | null = null;
          // Multiple assets of the SAME section (3 hooks, 2 bodies...) used to
          // stack on top of each other at the section start - unusable mush.
          // Now: the FIRST of each section lands on the timeline, the rest go
          // to the bin as canvas assets (category = section) for Versions /
          // the agent to swap in.
          const placedSections = new Set<string>();
          const altAssets: EditorAsset[] = [];
          const canvasUrls: string[] = [];
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
            if (kind !== "text" && t.value.startsWith("http")) canvasUrls.push(t.value);
            if (t.section && (kind === "video" || kind === "image" || kind === "audio")) {
              const secKey = `${t.section}:${kind === "audio" ? "a" : "v"}`;
              if (placedSections.has(secKey)) {
                altAssets.push({ id: `cvs-${Date.now()}-${i}`, url: t.value, kind, label: t.label || `${t.section} alt`, duration: null, category: t.section.toLowerCase() });
                return;
              }
              placedSections.add(secKey);
            }
            const ltype = clipLayerType(kind);
            // Sectioned clips (hook/body/packshot) share ONE lane per media
            // type: the chain keeps them back-to-back, and transitions only
            // work between neighbours on the SAME layer.
            let lid: string;
            if (t.section && (kind === "video" || kind === "image")) {
              if (!sharedSectionVideoLayer) { sharedSectionVideoLayer = `vimp_sec_${Date.now()}_${_l++}`; newLayers.push({ id: sharedSectionVideoLayer, type: "video", name: "Sections" }); }
              lid = sharedSectionVideoLayer;
            } else if (t.section && kind === "audio") {
              if (!sharedSectionAudioLayer) { sharedSectionAudioLayer = `aimp_sec_${Date.now()}_${_l++}`; newLayers.push({ id: sharedSectionAudioLayer, type: "audio", name: "Sections audio" }); }
              lid = sharedSectionAudioLayer;
            } else {
              lid = `${ltype[0]}imp_${Date.now()}_${i}_${_l++}`; // one fresh layer per track — guaranteed unique
              newLayers.push({ id: lid, type: ltype, ...(t.section ? { name: t.section } : {}) });
            }
            const sec = t.section ? { section: t.section } : {};
            if (kind === "text") {
              newClips.push({ id: uid(), kind, layer: lid, label: t.label || "Text", start: 0, duration: DEFAULTS.text, fadeIn: 0, fadeOut: 0, scale: 1, x: 0, y: 0, text: t.value, tstyle: { color: "#ffffff", shadow: true, plate: "none", enter: "", weight: 700 }, ...sec });
            } else {
              newClips.push({ id: uid(), kind, layer: lid, url: t.value, label: t.label || kind, start: 0, duration: DEFAULTS[kind], fadeIn: 0, fadeOut: 0, scale: 1, x: 0, y: 0, ...(kind === "video" || kind === "audio" ? { autoDur: true } : {}), ...sec });
            }
          });
          if (savedClips.length) {
            // MERGE: keep the existing assembly, stack the hand-off on top as
            // fresh layers. Imported hook/body/packshot sections still get the
            // sequential auto-layout (the layout pass only repositions clips
            // that carry a `section` tag, so the saved assembly is untouched).
            setLayers([...newLayers, ...savedLayers]);
            setClips([...savedClips, ...newClips]);
            if (newClips.some((c) => c.section)) sectionLayoutRef.current = true;
            if (altAssets.length) setCanvasAssets((prev) => [...altAssets, ...prev.filter((p) => !altAssets.some((a) => a.url === p.url))].slice(0, 60));
            if (canvasUrls.length) noteCanvasUrls(canvasUrls);
            if (altAssets.length) setAltNotice(altAssets);
          } else {
            if (!newLayers.some((l) => l.type === "video")) newLayers.push({ id: `vimp_${Date.now()}_${_l++}`, type: "video" });
            if (!newLayers.some((l) => l.type === "audio")) newLayers.push({ id: `aimp_${Date.now()}_${_l++}`, type: "audio" });
            setLayers(newLayers);
            setClips(newClips);
            if (newClips.some((c) => c.section)) sectionLayoutRef.current = true; // lay out sequentially once real durations arrive
          if (altAssets.length) setCanvasAssets((prev) => [...altAssets, ...prev.filter((p) => !altAssets.some((a) => a.url === p.url))].slice(0, 60));
          if (canvasUrls.length) noteCanvasUrls(canvasUrls);
          if (altAssets.length) setAltNotice(altAssets);
          }
          setSelectedIds([]);
          imported = true;
        }
      }
    } catch { /* malformed hand-off — ignore */ }
    if (imported) return;
    if (savedClips.length) { setClips(savedClips); setLayers(savedLayers); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const saveProject = useCallback(() => {
    try { localStorage.setItem(PROJECT_KEY, JSON.stringify({ clips: clipsRef.current, layers: layersRef.current, resKey, layouts: layoutsRef.current, versions: syncedVersions(), activeVer: activeVerRef.current, posMode: (posMigratedRef.current || !legacyPosRef.current) ? "frac" : undefined })); setSaveState("saved"); setTimeout(() => setSaveState(""), 1500); } catch { /* quota */ }
  }, [resKey]);
  useEffect(() => {
    if (!restoredRef.current) return;
    setSaveState("saving");
    const t = setTimeout(() => { try { localStorage.setItem(PROJECT_KEY, JSON.stringify({ clips, layers, resKey, layouts, versions: syncedVersions(), activeVer: activeVerRef.current, posMode: (posMigratedRef.current || !legacyPosRef.current) ? "frac" : undefined })); setSaveState("saved"); setTimeout(() => setSaveState(""), 1200); } catch { setSaveState(""); } }, 1200);
    return () => clearTimeout(t);
  }, [clips, layers, resKey, layouts, tlVersions]);
  // Switch the active output format, remembering each format's own layout.
  // Snapshot the current clips into the old format, then restore any saved
  // layout for the new one (clips the new format hasn't seen keep their spot).
  const switchFormat = useCallback((next: string) => {
    if (next === resKey || !RESOLUTIONS.some((r) => r.key === next)) return;
    const snap: Record<string, { x: number; y: number; scale: number }> = {};
    for (const c of clipsRef.current) snap[c.id] = { x: c.x, y: c.y, scale: c.scale };
    const saved = layoutsRef.current[next];
    setLayouts((prev) => ({ ...prev, [resKey]: snap }));
    if (saved) {
      setClips((cs) =>
        cs.map((c) => (saved[c.id] ? { ...c, x: saved[c.id].x, y: saved[c.id].y, scale: saved[c.id].scale } : c)),
      );
    }
    setResKey(next);
    flashStatus("Format changed. Clips FILL the frame by default (crop); right-click a clip \u2192 Fit or Blur bg to show it whole.", 6000);
  }, [resKey, flashStatus]);
  const newProject = () => {
    if (!window.confirm("Start a new project? The current timeline will be cleared (last autosave is overwritten).")) return;
    setClips([]); setSelectedIds([]); setLayers([{ id: "v1", type: "video" }, { id: "a1", type: "audio" }]); setLayouts({}); legacyPosRef.current = false; posMigratedRef.current = true; seek(0);
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
    for (const c of viewClips) {
      if (c.kind !== "text" || hiddenL.has(c.layer)) continue;
      if (playhead < c.start || playhead >= c.start + c.duration) continue;
      const r = drawCaption(ctx, c as unknown as ExportClip, playhead, W, H, 1, { opacity: alphaAt(c as CompClip, playhead) || 1, scaleMul: 1, offX: 0, offY: 0 });
      if (r) rects.push({ id: c.id, ...r });
    }
    // interactive handles only when paused (kept light during playback)
    setCapRects((prev) => (playing ? (prev.length ? [] : prev) : rects));
  }, [viewClips, layers, playhead, previewSize.w, previewSize.h, playing, fontsTick]);
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
  // natural media dimensions per clip (needed to render Fill/Fit as a real
  // full-frame box instead of an object-fit crop)
  const clipDimsRef = useRef<Map<string, { w: number; h: number }>>(new Map());
  const [, setDimsTick] = useState(0);
  const noteClipDims = (id: string, w: number, h: number) => {
    if (!w || !h) return;
    const cur = clipDimsRef.current.get(id);
    if (cur && cur.w === w && cur.h === h) return;
    clipDimsRef.current.set(id, { w, h });
    setDimsTick((n) => n + 1);
  };
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
  const generateSubtitles = async (srcId?: string) => {
    const src = subSources.find((c) => c.id === (srcId || subSource)) || subSources[0];
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

  // Server-render the screen replace for the selected clip (same compositor as
  // the Screen Replace node). On success the clip's url becomes the composite.
  const renderSR = async () => {
    const c = clipsRef.current.find((x) => x.id === selectedRef.current[selectedRef.current.length - 1]);
    if (!c?.sr?.green || !c.sr.content) return;
    setSrBusy(true); setSrErr(null);
    try {
      const r = await fetch("/api/screen-replace/render", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: c.sr.green, content: c.sr.content, contentIsVideo: !!c.sr.contentVideo,
          keyColorHex: c.sr.key || "#00FF00", similarity: c.sr.sim ?? 0.3, fit: c.sr.fit || "fill",
          scaleX: c.sr.scaleX ?? 1, scaleY: c.sr.scaleY ?? 1, matteChoke: c.sr.matte ?? 0, feather: c.sr.feather ?? 0,
          trackKeys: c.sr.keys || [], trackMode: c.sr.mode || "anchor",
          projectId, workflowId,
        }),
      });
      const j = await r.json();
      if (!r.ok || !j.url) throw new Error(j.error || "Render failed");
      updateSel(c.id, { url: j.url, keyColor: undefined, keyTol: undefined });
    } catch (e) {
      setSrErr(e instanceof Error ? e.message : "Render failed");
    } finally {
      setSrBusy(false);
    }
  };
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
  // Cut-tool: split ONE clip at an absolute time (same rules as the razor).
  const splitOneAt = useCallback((id: string, t: number) => {
    setClips((prev) => {
      const c = prev.find((x) => x.id === id);
      if (!c || t <= c.start + 0.05 || t >= c.start + c.duration - 0.05) return prev;
      const cut = +(t - c.start).toFixed(3);
      const first: EditClip = { ...c, duration: cut, fadeOut: 0 };
      const second: EditClip = { ...c, id: uid(), start: +t.toFixed(3), duration: +(c.duration - cut).toFixed(3), inset: +((c.inset || 0) + cut).toFixed(3), fadeIn: 0 };
      if (c.kind === "text" && c.words?.length) {
        const fw = c.words.filter((w) => w.t < cut);
        const sw = c.words.filter((w) => w.t >= cut).map((w) => ({ ...w, t: +(w.t - cut).toFixed(3) }));
        first.words = fw; first.text = fw.map((w) => w.text).join(" ") || c.text;
        second.words = sw; second.text = sw.map((w) => w.text).join(" ") || c.text;
      }
      return prev.flatMap((x) => (x.id === id ? [first, second] : [x]));
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
  const sectionLayoutRef = useRef(false); // legacy import flag - chaining is continuous now
  useEffect(() => {
    // ADAPTIVE section chain: whenever any sectioned clip's duration changes
    // (metadata arrived, trim, or a version variant with its own length), the
    // whole hook -> body -> packshot sequence re-times itself. Dragging a
    // sectioned clip by hand detaches it from the chain (see onClipPointerUp).
    sectionLayoutRef.current = false;
    if (dragRef.current) return; // never fight an active drag
    setClips((prev) => { const next = chainSections(prev); return next === prev ? prev : next; });
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

  // One-time migration of legacy px offsets -> canvas fractions (x/W, y/H),
  // run as soon as the preview has been measured so positions stop drifting
  // when the preview is resized or the format changes.
  useEffect(() => {
    if (posMigratedRef.current || !legacyPosRef.current) return;
    const pw = previewSize.w, ph = previewSize.h;
    if (pw < 2 || ph < 2) return;
    posMigratedRef.current = true;
    setClips((cs) => cs.map((c) => ({ ...c, x: (c.x || 0) / pw, y: (c.y || 0) / ph })));
    setLayouts((ls) => {
      const out: Record<string, Record<string, { x: number; y: number; scale: number }>> = {};
      for (const f in ls) { out[f] = {}; for (const id in ls[f]) { const o = ls[f][id]; out[f][id] = { x: o.x / pw, y: o.y / ph, scale: o.scale }; } }
      return out;
    });
  }, [previewSize.w, previewSize.h]);

  const layersRef = useRef<Layer[]>([]);
  layersRef.current = layers;
  // Volume boost: HTMLMediaElement.volume is hard-clamped to 1.0 by browsers,
  // so 100% and 200% used to sound identical. Elements are routed through a
  // per-element GainNode on demand (only once volume goes above 1), which
  // supports real gain. Wired lazily inside a user-gesture-driven loop.
  const boostCtxRef = useRef<AudioContext | null>(null);
  const boostGainsRef = useRef<Map<HTMLMediaElement, GainNode>>(new Map());
  const applyVolume = useCallback((el: HTMLMediaElement, vol: number) => {
    const wired = boostGainsRef.current.get(el);
    if (!wired && vol <= 1) { try { el.volume = Math.max(0, vol); } catch { /* */ } return; }
    try {
      let ctx = boostCtxRef.current;
      if (!ctx) {
        const AC: typeof AudioContext = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        ctx = new AC(); boostCtxRef.current = ctx;
      }
      if (ctx.state === "suspended") ctx.resume().catch(() => {});
      let g = wired;
      if (!g) {
        const src = ctx.createMediaElementSource(el);
        g = ctx.createGain();
        src.connect(g); g.connect(ctx.destination);
        boostGainsRef.current.set(el, g);
        try { el.volume = 1; } catch { /* */ }
      }
      g.gain.value = Math.max(0, vol);
    } catch { try { el.volume = Math.max(0, Math.min(1, vol)); } catch { /* */ } }
  }, []);
  const syncMedia = useCallback((tt: number) => {
    const hidden = new Set(layersRef.current.filter((l) => l.hidden).map((l) => l.id));
    for (const c of viewClipsRef.current) {
      const el = mediaRefs.current.get(c.id); if (!el) continue;
      const active = tt >= c.start && tt < c.start + c.duration && !hidden.has(c.layer);
      if (active) {
        const local = tt - c.start + (c.inset || 0);
        if (!el.seeking && Math.abs(el.currentTime - local) > 0.5) { try { el.currentTime = local; } catch { /* */ } }
        applyVolume(el, alphaAt(c, tt) * (c.muted ? 0 : (c.volume ?? 1)));
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
      // Keep the blurred-background video copy (if any) in sync with its clip.
      const bg = mediaRefs.current.get(c.id + "::bg");
      if (bg) {
        if (active) {
          const local = tt - c.start + (c.inset || 0);
          if (!bg.seeking && Math.abs(bg.currentTime - local) > 0.5) { try { bg.currentTime = local; } catch { /* */ } }
          if (playingRef.current && bg.paused) bg.play().catch(() => {});
          if (!playingRef.current && !bg.paused) bg.pause();
        } else if (!bg.paused) bg.pause();
      }
    }
  }, [applyVolume]);
  const stop = useCallback(() => {
    playingRef.current = false; setPlaying(false);
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    for (const el of mediaRefs.current.values()) { try { el.pause(); } catch { /* */ } }
  }, []);
  const loop = useCallback((now: number) => {
    const rawDt = (now - lastTsRef.current) / 1000; lastTsRef.current = now;
    // Hold the clock while an active video is still buffering, so audio/video/
    // playhead stay together instead of the playhead racing ahead (which would
    // force corrective seeks and freeze the clip). Cap dt so a backgrounded tab
    // can't jump the playhead far.
    let buffering = false;
    const tt0 = playheadRef.current;
    for (const c of clipsRef.current) {
      if (c.kind !== "video" || tt0 < c.start || tt0 >= c.start + c.duration) continue;
      const el = mediaRefs.current.get(c.id);
      if (el && el.readyState < 3 && !el.error) { buffering = true; break; }
    }
    const dt = buffering ? 0 : Math.min(0.25, rawDt);
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

  // Precompute + cache the green-screen track for the selected screen-replace clip
  // so "Adjust track" opens instantly (the canvas feels instant because it reuses
  // the track already computed during the node run).
  useEffect(() => {
    const c = clips.find((x) => x.id === selected);
    const url = c?.sr?.green;
    if (!url || srTrackCache[url]) return;
    setSrTrackCache((s) => ({ ...s, [url]: "loading" }));
    fetch("/api/screen-replace/track", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source: url }) })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("track failed"))))
      .then((j) => setSrTrackCache((s) => ({ ...s, [url]: { fps: j.fps || 30, w: j.w || 1080, h: j.h || 1920, quads: j.quads || [] } })))
      .catch(() => setSrTrackCache((s) => ({ ...s, [url]: "error" })));
  }, [selected, clips, srTrackCache]);

  // Pause editor playback while the track editor (Adjust) is open — keeps the
  // overlay in sync with the video and frees the main thread for tracking.
  useEffect(() => { if (trackOpen) stop(); }, [trackOpen, stop]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tg = e.target as HTMLElement | null;
      if (tg && (tg.tagName === "INPUT" || tg.tagName === "TEXTAREA" || tg.tagName === "SELECT" || tg.isContentEditable)) return;
      if (e.code === "Space") { e.preventDefault(); play(); }
      else if (!e.metaKey && !e.ctrlKey && (e.code === "ArrowLeft" || e.code === "ArrowRight")) {
        // frame-by-frame stepping for precise trims: 1 frame (1/30s), Shift = 10 frames
        e.preventDefault();
        stop();
        const step = (e.shiftKey ? 10 : 1) / 30;
        seek(playheadRef.current + (e.code === "ArrowRight" ? step : -step));
      }
      else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
      else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "y") { e.preventDefault(); redo(); }
      else if ((e.metaKey || e.ctrlKey) && e.code === "KeyD") { e.preventDefault(); duplicateSelected(); }
      else if ((e.metaKey || e.ctrlKey) && e.code === "KeyB") { e.preventDefault(); splitAtPlayhead(); }
      else if (!e.metaKey && !e.ctrlKey && e.code === "KeyS") { e.preventDefault(); splitAtPlayhead(); }
      else if (e.code === "Escape" && cutModeRef.current) { setCutMode(false); }
      else if (e.key === "Delete" || e.key === "Backspace") { if (selectedRef.current.length) { e.preventDefault(); removeMany(selectedRef.current); } }
    };
    window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey);
  }, [play, removeMany, undo, redo, duplicateSelected, splitAtPlayhead, stop, seek]);

  useEffect(() => {
    if (!menu && !transMenu) return;
    const close = () => { setMenu(null); setTransMenu(null); };
    window.addEventListener("click", close); window.addEventListener("scroll", close, true); window.addEventListener("resize", close);
    return () => { window.removeEventListener("click", close); window.removeEventListener("scroll", close, true); window.removeEventListener("resize", close); };
  }, [menu, transMenu]);

  // Build the export filename from the naming template + live values.
  // versionOverride / formatKey let the batch renderer set per-version values.
  const buildFileName = useCallback((ext: string, versionOverride?: string, formatKey?: string) => {
    const r = RESOLUTIONS.find((x) => x.key === (formatKey ?? resKey)) ?? RESOLUTIONS[0];
    const dur = Math.max(1, Math.round(endOf(clipsRef.current)));
    const tokens: Record<string, string> = {
      date: namingDate(),
      brand: (naming.brandCode || guessBrandCode(brandName)).trim(),
      project: (projectName || "creative").trim(),
      type: "video",
      version: versionOverride || naming.version || "v1",
      resolution: `${r.w}x${r.h}`,
      duration: `${dur}s`,
      lang: naming.lang || "en",
      initials: naming.initials || "",
    };
    const raw = (naming.template || NAMING_DEFAULT.template).replace(/\{(\w+)\}/g, (_m, k) => tokens[k] ?? "");
    // Drop empty token gaps while preserving the "__" concept/spec separator.
    const name = raw.split("__").map((seg) => seg.split("_").filter(Boolean).join("_")).filter(Boolean).join("__");
    return `${name || `creative-${Date.now()}`}.${ext}`;
  }, [naming, projectName, brandName, resKey]);

  // One clip -> the export-clip shape (shared by single + batch export).
  const toExportClip = useCallback((c: EditClip) => ({ id: c.id, layer: c.layer, kind: c.kind, url: c.url, text: c.text, start: c.start, duration: c.duration, scale: c.scale, x: c.x, y: c.y, fit: c.fit, rot: c.rot, kf: c.kf, fadeIn: c.fadeIn, fadeOut: c.fadeOut, anim: c.anim, fx: c.fx, transType: c.transType, inset: c.inset, volume: c.volume, muted: c.muted, blend: c.blend, keyColor: c.keyColor, keyTol: c.keyTol, tstyle: c.tstyle, words: c.words, sr: c.sr }), []);

  // Render every version (variant combo) x every chosen format, each downloaded
  // with its own templated name (version token = v1..vN per combo).
  const renderVersions = useCallback(async (only: number | null, fmtOverride?: Set<string>) => {
    if (batchRunning || exporting || !clipsRef.current.length) return;
    const fmts = RESOLUTIONS.filter((r) => (fmtOverride ?? batchFormats).has(r.key));
    if (!fmts.length) { setStatus("Pick at least one format to render."); return; }
    setVersionsOpen(false); setBatchRunning(true); setProgress(0); stop();
    try {
      const { exportTimeline } = await import("@/lib/editor/exportVideo");
      const all: TLSnapshot[] = tlVersionsRef.current.length
        ? syncedVersions()
        : [{ id: "cur", name: "", clips: clipsRef.current, layers: layersRef.current }];
      const indices = only != null && all[only] ? [only] : all.map((_, i) => i);
      const total = indices.length * fmts.length;
      let done = 0;
      for (const vi of indices) {
        const snap = all[vi];
        const verClips = snap.clips;
        const vis = snap.layers.filter((l) => l.type !== "audio");
        const hiddenIds = new Set(snap.layers.filter((l) => l.hidden).map((l) => l.id));
        const z: EditClip[] = [];
        for (let i = vis.length - 1; i >= 0; i--) { if (hiddenIds.has(vis[i].id)) continue; z.push(...verClips.filter((c) => c.layer === vis[i].id).sort((a, b) => a.start - b.start)); }
        const ordered = [...z, ...verClips.filter((c) => !z.includes(c) && !hiddenIds.has(c.layer))];
        const vName = `v${vi + 1}`;
        for (const r of fmts) {
          setStatus(`Rendering ${vName} \u00b7 ${r.key} (${done + 1}/${total})\u2026`);
          const { blob, ext } = await exportTimeline({
            clips: ordered.map(toExportClip),
            width: r.w, height: r.h, previewWidth: previewSize.w,
            onProgress: (p) => setProgress(Math.round(((done + p) / total) * 100)),
            onStage: (msg) => setStatus(`${vName} ${r.key}: ${msg}`),
          });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url; a.download = buildFileName(ext, vName, r.key);
          document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
          done++;
          await new Promise((res) => setTimeout(res, 500)); // stagger downloads
        }
      }
      setStatus(`Done \u2014 ${total} file(s) downloaded.`);
    } catch (e) { console.error(e); setStatus(`Batch failed: ${e instanceof Error ? e.message : "see console"}`); }
    finally { setBatchRunning(false); }
  }, [batchRunning, exporting, batchFormats, previewSize, stop, buildFileName, toExportClip, syncedVersions]);
  const renderAllVersions = useCallback(() => renderVersions(null), [renderVersions]);
  const renderOneVersion = useCallback((vi: number) => renderVersions(vi), [renderVersions]);

  // ── Timeline-version operations (full snapshots) ──
  const mkSnap = useCallback((): TLSnapshot => ({
    id: `tv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`,
    name: "",
    clips: clipsRef.current,
    layers: layersRef.current,
  }), []);
  const clearHist = useCallback(() => { histRef.current = []; histPosRef.current = -1; }, []);
  const switchVersion = useCallback((i: number) => {
    const vs = tlVersionsRef.current;
    if (!vs.length || i === activeVerRef.current || i < 0 || i >= vs.length) return;
    const synced = syncedVersions();
    const target = synced[i];
    setTlVersions(synced);
    setActiveVer(i);
    setSelectedIds([]);
    setClips(target.clips);
    setLayers(target.layers);
    clearHist(); // undo must never cross versions
  }, [syncedVersions, clearHist]);
  // "+" - snapshot the current timeline as a NEW version and keep editing it.
  const addVersionFromCurrent = useCallback(() => {
    const vs = tlVersionsRef.current;
    if (!vs.length) {
      // first fork: current state becomes v1, an identical copy becomes v2
      setTlVersions([mkSnap(), mkSnap()]);
      setActiveVer(1);
    } else {
      const synced = syncedVersions();
      setTlVersions([...synced, mkSnap()]);
      setActiveVer(synced.length);
    }
    clearHist();
    flashStatus("New version created \u2014 you are editing it now.");
  }, [mkSnap, syncedVersions, clearHist]);
  const duplicateVersion = useCallback((i: number) => {
    const synced = syncedVersions();
    const src = synced[i];
    if (!src) return;
    setTlVersions([...synced, { ...src, id: `tv-${Date.now().toString(36)}`, clips: src.clips, layers: src.layers }]);
  }, [syncedVersions]);
  const deleteVersion = useCallback((i: number) => {
    const vs = tlVersionsRef.current;
    if (i < 0 || i >= vs.length) return;
    const cur = activeVerRef.current;
    const next = vs.filter((_, k) => k !== i);
    setTlVersions(next);
    if (!next.length) { setActiveVer(0); return; } // back to a single implicit version (current state stays)
    if (cur === i) {
      const ni = Math.max(0, i - 1);
      const t = next[ni];
      setActiveVer(ni);
      setSelectedIds([]);
      setClips(t.clips);
      setLayers(t.layers);
      clearHist();
    } else if (cur > i) setActiveVer(cur - 1);
  }, [clearHist]);
  // Generate one version per bin asset of a category, replacing the given
  // clip in a copy of the CURRENT timeline (chain re-times each copy).
  const generateVersions = useCallback((clipId: string, category: string) => {
    const src = clipsRef.current;
    const c = src.find((x) => x.id === clipId);
    if (!c) return 0;
    const pool = (category === "all" ? [...library, ...brandLib] : brandLib.filter((a) => a.category === category))
      .filter((a) => a.kind === c.kind && a.url && a.url !== c.url);
    const seen = new Set<string>();
    const fresh: TLSnapshot[] = [];
    for (const a of pool) {
      if (seen.has(a.url)) continue;
      seen.add(a.url);
      const cl = src.map((x) => (x.id === clipId
        ? { ...x, url: a.url, inset: 0, ...(a.duration && x.section && x.kind === "video" ? { duration: +a.duration.toFixed(2), autoDur: false } : { autoDur: true }) }
        : x));
      fresh.push({ id: `tv-${a.id}-${Math.random().toString(36).slice(2, 5)}`, name: "", clips: chainSections(cl), layers: layersRef.current });
    }
    if (!fresh.length) return 0;
    const base = tlVersionsRef.current.length ? syncedVersions() : [mkSnap()];
    setTlVersions([...base, ...fresh]);
    return fresh.length;
  }, [library, brandLib, syncedVersions, mkSnap]);

  // Build one version per COMBINATION of section alternates (2 hooks x 2
  // bodies -> 4 timelines). Capped to 12; the current cut stays as v1.
  const buildComboVersions = useCallback((alts: EditorAsset[]): number => {
    const bySec = new Map<string, EditorAsset[]>();
    for (const a of alts) {
      const sec = (a.category || "").toLowerCase();
      if (!sec) continue;
      bySec.set(sec, [...(bySec.get(sec) || []), a]);
    }
    const src = clipsRef.current;
    const secClip = (sec: string) => src.find((c) => (c.section || "").toLowerCase() === sec && (c.kind === "video" || c.kind === "image"));
    const dims: { sec: string; clipId: string; options: (EditorAsset | null)[] }[] = [];
    for (const [sec, list] of bySec) {
      const c = secClip(sec);
      if (!c) continue;
      dims.push({ sec, clipId: c.id, options: [null, ...list] }); // null = keep the placed asset
    }
    if (!dims.length) return 0;
    let combos: (EditorAsset | null)[][] = [[]];
    for (const d of dims) {
      const next: (EditorAsset | null)[][] = [];
      for (const c of combos) for (const o of d.options) next.push([...c, o]);
      combos = next;
    }
    combos = combos.filter((c) => c.some((o) => o !== null)).slice(0, 12); // drop the all-base combo, cap
    if (!combos.length) return 0;
    const fresh: TLSnapshot[] = combos.map((combo, ci) => {
      const cl = src.map((x) => {
        const di = dims.findIndex((d) => d.clipId === x.id);
        if (di === -1) return x;
        const pick = combo[di];
        if (!pick) return x;
        const dur = pick.duration ?? frameCache.get(pick.url)?.dur;
        return { ...x, url: pick.url, label: pick.label || x.label, inset: 0, ...(dur && x.section && x.kind === "video" ? { duration: +dur.toFixed(2), autoDur: false } : { autoDur: true }) };
      });
      return { id: `tvc-${Date.now().toString(36)}-${ci}`, name: "", clips: chainSections(cl), layers: layersRef.current };
    });
    const base = tlVersionsRef.current.length ? syncedVersions() : [mkSnap()];
    setTlVersions([...base, ...fresh]);
    return fresh.length;
  }, [syncedVersions, mkSnap]);
  const clipLabel = useCallback((c: EditClip) => (c.kind === "text" ? `"${(c.text || "text").slice(0, 22)}"` : (assets.find((a) => a.url === c.url)?.label || c.kind)), [assets]);
  // Human-readable label for an asset URL (bin label, else the file name).
  const urlLabel = useCallback((u?: string) => {
    if (!u) return "?";
    const a = assets.find((x) => x.url === u) || brandLib.find((x) => x.url === u);
    if (a) return a.label;
    try { return decodeURIComponent(u.split("/").pop()!.split("?")[0]).slice(0, 26); } catch { return "asset"; }
  }, [assets, brandLib]);
  // Human summary of a snapshot: what differs from v1, else duration + count.
  const describeSnap = useCallback((v: TLSnapshot): string => {
    const base = tlVersionsRef.current[0];
    const parts: string[] = [];
    if (base && base !== v) {
      const baseBy = new Map(base.clips.map((c) => [c.id, c]));
      for (const c of v.clips) {
        const b = baseBy.get(c.id);
        if (!b) { parts.push(`+ ${c.section ?? clipLabel(c)}`); continue; }
        if (b.url !== c.url) parts.push(`${c.section ?? clipLabel(c)}: ${urlLabel(c.url)}`);
        else if ((b.text ?? "") !== (c.text ?? "")) parts.push(`text: "${(c.text ?? "").slice(0, 18)}"`);
      }
      for (const b of base.clips) if (!v.clips.some((c) => c.id === b.id)) parts.push(`removed ${b.section ?? clipLabel(b)}`);
    }
    if (parts.length) return parts.slice(0, 4).join(" \u00b7 ") + (parts.length > 4 ? ` \u00b7 +${parts.length - 4}` : "");
    const dur = Math.round(Math.max(0, ...v.clips.map((c) => c.start + c.duration), 0));
    const n = v.clips.filter((c) => c.kind === "video" || c.kind === "image" || c.kind === "text").length;
    return `${dur}s \u00b7 ${n} clip${n === 1 ? "" : "s"}`;
  }, [clipLabel, urlLabel]);
  // One-tap versions from the banner: a version per Hook asset in the library.
  const buildHookVersions = useCallback(() => {
    const hooks = brandLib.filter((a) => a.category === "hook" && (a.kind === "video" || a.kind === "image"));
    const hookUrls = new Set(hooks.map((h) => h.url));
    const slot = clipsRef.current.find((c) => c.section === "Hook" && (c.kind === "video" || c.kind === "image")) ||
      clipsRef.current.find((c) => c.url != null && hookUrls.has(c.url)) ||
      clipsRef.current.filter((c) => c.kind === "video" || c.kind === "image").sort((a, b) => a.start - b.start)[0];
    if (!slot) return;
    generateVersions(slot.id, "hook");
    setVersionsOpen(true);
    setHookBannerDismissed(true);
  }, [brandLib, generateVersions]);

  const exportMp4 = useCallback(async () => {
    if (exporting || !clips.length) return;
    setExporting(true); setProgress(0); setStatus("Preparing sources…"); stop();
    try {
      // Export exactly what the preview shows: the currently previewed version.
      const src = viewClipsRef.current;
      const vis = layers.filter((l) => l.type !== "audio");
      const hiddenIds = new Set(layers.filter((l) => l.hidden).map((l) => l.id));
      const z: EditClip[] = [];
      for (let i = vis.length - 1; i >= 0; i--) { if (hiddenIds.has(vis[i].id)) continue; z.push(...src.filter((c) => c.layer === vis[i].id).sort((a, b) => a.start - b.start)); }
      const ordered = [...z, ...src.filter((c) => !z.includes(c) && !hiddenIds.has(c.layer))];
      const { exportTimeline } = await import("@/lib/editor/exportVideo");
      const { blob, ext, mp4 } = await exportTimeline({
        clips: ordered.map((c) => ({ id: c.id, layer: c.layer, kind: c.kind, url: c.url, text: c.text, start: c.start, duration: c.duration, scale: c.scale, x: c.x, y: c.y, fit: c.fit, rot: c.rot, kf: c.kf, fadeIn: c.fadeIn, fadeOut: c.fadeOut, anim: c.anim, fx: c.fx, transType: c.transType, inset: c.inset, volume: c.volume, muted: c.muted, blend: c.blend, keyColor: c.keyColor, keyTol: c.keyTol, tstyle: c.tstyle, words: c.words, sr: c.sr })),
        width: res.w, height: res.h, previewWidth: previewSize.w,
        onProgress: (p) => setProgress(Math.round(p * 100)),
        onStage: (m) => setStatus(m),
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url; a.download = buildFileName(ext, tlVersionsRef.current.length ? `v${activeVer + 1}` : undefined);
      document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
      setStatus(mp4 ? "Done — MP4 downloaded." : "Done — WebM downloaded (browser doesn\u2019t support MP4 recording).");
    } catch (e) { console.error(e); setStatus(`Export failed: ${e instanceof Error ? e.message : "see console"}`); }
    finally { setExporting(false); }
  }, [exporting, clips.length, layers, res, previewSize, stop, buildFileName, activeVer]);

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
        clips: ordered.map((c) => ({ id: c.id, layer: c.layer, kind: c.kind, url: c.url, text: c.text, start: c.start, duration: c.duration, scale: c.scale, x: c.x, y: c.y, fit: c.fit, rot: c.rot, kf: c.kf, fadeIn: c.fadeIn, fadeOut: c.fadeOut, anim: c.anim, fx: c.fx, transType: c.transType, inset: c.inset, volume: c.volume, muted: c.muted, blend: c.blend, keyColor: c.keyColor, keyTol: c.keyTol, tstyle: c.tstyle, words: c.words, sr: c.sr })),
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
    if (cutModeRef.current && mode === "move" && e.button === 0) {
      // scissors tool: split where the cursor points instead of dragging
      e.stopPropagation();
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const frac = Math.min(1, Math.max(0, (e.clientX - r.left) / Math.max(1, r.width)));
      splitOneAt(c.id, c.start + frac * c.duration);
      return;
    }
    e.stopPropagation();
    if (isLocked(c)) return; (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
    const ids = additive ? (selectedRef.current.includes(c.id) ? selectedRef.current.filter((x) => x !== c.id) : [...selectedRef.current, c.id]) : (selectedRef.current.includes(c.id) ? selectedRef.current : [c.id]);
    setSelectedIds(ids);
    const moveIds = mode === "move" ? (ids.length ? ids : [c.id]) : [c.id];
    const origStarts = new Map(moveIds.map((id) => [id, clipsRef.current.find((x) => x.id === id)?.start ?? 0]));
    dragRef.current = { id: c.id, mode, startX: e.clientX, origDur: c.duration, origStart: c.start, origInset: c.inset || 0, type: layerType(c), moveIds, origStarts };
    if (mode === "move") setClipDragging(true);
  };
  const onClipPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current; if (!d) return; const dx = (e.clientX - d.startX) / pxPerSec;
    // Magnet: snap the dragged edge to other clips' edges, the playhead and 0
    // when within ~8px. Hold Alt to disable snapping.
    const snapDelta = (raw: number, dur: number): number => {
      if (e.altKey) return raw;
      const thr = 8 / pxPerSec;
      const targets: number[] = [0, playheadRef.current];
      for (const o of clipsRef.current) {
        if (d.moveIds.includes(o.id)) continue;
        targets.push(o.start, o.start + o.duration);
      }
      let best = raw, bestDist = thr;
      for (const t of targets) {
        const dStart = Math.abs(raw - t);
        if (dStart < bestDist) { best = t; bestDist = dStart; }
        const dEnd = Math.abs(raw + dur - t);
        if (dEnd < bestDist) { best = t - dur; bestDist = dEnd; }
      }
      return best;
    };
    if (d.mode === "move") {
      const lead = clipsRef.current.find((x) => x.id === d.id);
      const rawLead = Math.max(0, (d.origStarts.get(d.id) ?? 0) + dx);
      const snapped = snapDelta(rawLead, lead?.duration ?? 0);
      const adj = snapped - rawLead; // shift every dragged clip by the same snap offset
      setClips((prev) => prev.map((x) => (d.moveIds.includes(x.id) ? { ...x, start: Math.max(0, +((d.origStarts.get(x.id) ?? x.start) + dx + adj).toFixed(3)) } : x)));
      setDropHint(d.moveIds.length > 1 ? null : hitTest(e.clientY, d.type)); // layer change only for a single clip
    } else if (d.mode === "trim") {
      const c = clipsRef.current.find((x) => x.id === d.id);
      const isMedia = c && (c.kind === "video" || c.kind === "audio");
      const maxDur = isMedia && c?.srcDur ? Math.max(MIN_DUR, c.srcDur - (c.inset || 0)) : Infinity; // drag right again to restore up to the source length
      let dur = Math.max(MIN_DUR, Math.min(maxDur, +(d.origDur + dx).toFixed(2)));
      // snap the right edge
      const snappedEnd = snapDelta(d.origStart + dur, 0);
      const durSnapped = Math.max(MIN_DUR, Math.min(maxDur, snappedEnd - d.origStart));
      if (Math.abs(durSnapped - dur) < 8 / pxPerSec) dur = +durSnapped.toFixed(3);
      update(d.id, { duration: dur });
    } else if (d.mode === "trimL") {
      const c = clipsRef.current.find((x) => x.id === d.id);
      const isMedia = c && (c.kind === "video" || c.kind === "audio");
      // left edge: dragging right trims; dragging left restores hidden head (down to inset 0)
      const minDx = Math.max(isMedia ? -d.origInset : -Infinity, -d.origStart);
      const maxDx = d.origDur - MIN_DUR;
      let ddx = Math.max(minDx, Math.min(maxDx, dx));
      // snap the left edge
      const snappedStart = snapDelta(d.origStart + ddx, 0);
      const ddxSnapped = Math.max(minDx, Math.min(maxDx, snappedStart - d.origStart));
      if (Math.abs(ddxSnapped - ddx) < 8 / pxPerSec) ddx = ddxSnapped;
      update(d.id, {
        start: +(d.origStart + ddx).toFixed(2),
        duration: +(d.origDur - ddx).toFixed(2),
        ...(isMedia ? { inset: +(d.origInset + ddx).toFixed(3) } : {}),
      });
    }
  };
  const onClipPointerUp = () => {
    setClipDragging(false);
    const d = dragRef.current; dragRef.current = null;
    const hint = dropHintRef.current; setDropHint(null);
    // Manually MOVING a sectioned clip detaches it from the auto-chained
    // hook/body/packshot sequence (otherwise the chain would snap it back).
    if (d && d.mode === "move") {
      const moved = d.moveIds.filter((id) => {
        const c = clipsRef.current.find((x) => x.id === id);
        return c?.section && Math.abs(c.start - (d.origStarts.get(id) ?? c.start)) > 0.05;
      });
      if (moved.length) {
        setClips((p) => p.map((c) => (moved.includes(c.id) ? { ...c, section: undefined } : c)));
        flashStatus("Detached from the section chain - the clip now moves freely.");
      }
    }
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
  // Viewport zoom wheel. Attached as a NATIVE non-passive listener (React's
  // synthetic onWheel is passive in Chromium, so preventDefault() there floods
  // the console with "Unable to preventDefault" errors and the page scrolls).
  const viewWheelRef = useRef<(e: WheelEvent) => void>(() => {});
  viewWheelRef.current = (e: WheelEvent) => {
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
  useEffect(() => {
    const el = containerRef.current; if (!el) return;
    const h = (e: WheelEvent) => viewWheelRef.current(e);
    el.addEventListener("wheel", h, { passive: false });
    return () => el.removeEventListener("wheel", h);
  }, []);
  // Timeline wheel: Cmd/Ctrl = horizontal zoom, Alt = lane height. Native
  // non-passive listener for the same passive-preventDefault reason.
  const timelineWheelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = timelineWheelRef.current; if (!el) return;
    const h = (e: WheelEvent) => {
      if (e.metaKey || e.ctrlKey) { e.preventDefault(); setPxPerSec((z) => Math.min(400, Math.max(2, Math.round(z * (e.deltaY < 0 ? 1.12 : 0.89))))); }
      else if (e.altKey) { e.preventDefault(); setLaneH((hh) => Math.min(96, Math.max(28, hh + (e.deltaY < 0 ? 4 : -4)))); }
    };
    el.addEventListener("wheel", h, { passive: false });
    return () => el.removeEventListener("wheel", h);
  }, []);
  const onPanDown = (e: React.PointerEvent) => {
    if (e.button !== 0 && e.button !== 1) return;
    if (e.button === 0) setSelectedIds([]);
    const s = { x: e.clientX, y: e.clientY, ox: viewPan.x, oy: viewPan.y };
    const move = (ev: PointerEvent) => setViewPan({ x: s.ox + (ev.clientX - s.x), y: s.oy + (ev.clientY - s.y) });
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  };
  const onVpDown = (e: React.PointerEvent, c: EditClip, mode: "move" | "scale" | "rotate") => {
    if (e.button === 1) return; // middle button → let the viewport pan
    e.stopPropagation();
    if (isLocked(c)) return;
    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
    const ids = additive ? (selectedRef.current.includes(c.id) ? selectedRef.current.filter((x) => x !== c.id) : [...selectedRef.current, c.id]) : (selectedRef.current.includes(c.id) ? selectedRef.current : [c.id]);
    setSelectedIds(ids);
    const TH = 10; const STEPS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3];
    const groupIds = mode === "move" ? (ids.length ? ids : [c.id]) : [c.id];
    const orig = new Map(groupIds.map((id) => { const cc = clipsRef.current.find((x) => x.id === id); return [id, { x: cc?.x ?? 0, y: cc?.y ?? 0 }]; }));
    const s = { sx: e.clientX, sy: e.clientY, ox: c.x, oy: c.y, os: c.scale, or: c.rot ?? 0 };
    // rotation: angle from the clip's on-screen centre to the cursor
    const box = (e.currentTarget as HTMLElement).parentElement?.getBoundingClientRect();
    const cx0 = box ? box.left + box.width / 2 : e.clientX;
    const cy0 = box ? box.top + box.height / 2 : e.clientY;
    const angleAt = (px: number, py: number) => (Math.atan2(py - cy0, px - cx0) * 180) / Math.PI;
    const a0 = angleAt(e.clientX, e.clientY);
    const move = (ev: PointerEvent) => {
      const z = viewZoomRef.current || 1; const dxr = (ev.clientX - s.sx) / z, dyr = (ev.clientY - s.sy) / z;
      if (mode === "rotate") {
        let rot = s.or + (angleAt(ev.clientX, ev.clientY) - a0);
        rot = ((rot + 180) % 360 + 360) % 360 - 180; // normalize to -180..180
        if (ev.shiftKey) rot = Math.round(rot / 15) * 15; // snap to 15 deg steps
        if (Math.abs(rot) < 3 && !ev.shiftKey) rot = 0; // gentle zero snap
        update(c.id, { rot: Math.round(rot * 10) / 10 });
        return;
      }
      if (mode === "move") {
        const pw = previewSize.w || 1, ph = previewSize.h || 1;
        // snap based on the grabbed clip, apply the same (snapped) delta to the whole selection
        let nx = s.ox + dxr / pw, ny = s.oy + dyr / ph;
        const v = Math.abs(nx) * pw < TH; if (v) nx = 0;
        const h = Math.abs(ny) * ph < TH; if (h) ny = 0;
        setSnap({ v, h });
        const ddx = nx - s.ox, ddy = ny - s.oy;
        setClips((prev) => prev.map((x) => { const o = orig.get(x.id); return o ? { ...x, x: o.x + ddx, y: o.y + ddy } : x; }));
      } else {
        let ns = +(s.os + (dxr + dyr) / 250).toFixed(2);
        const hit = STEPS.find((st) => Math.abs(ns - st) < 0.05); if (hit) ns = hit;
        update(c.id, { scale: Math.min(8, Math.max(0.05, ns)) });
      }
    };
    const up = () => { setSnap({ v: false, h: false }); window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  };
  const resetTransform = (id: string) => update(id, { x: 0, y: 0, scale: 1, rot: 0 });
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
      const pw = previewSize.w || 1, ph = previewSize.h || 1;
      const dx = (ev.clientX - s.sx) / z / pw, dy = (ev.clientY - s.sy) / z / ph;
      setClips((prev) => prev.map((x) => { const o = orig.get(x.id); return o ? { ...x, x: o.x + dx, y: o.y + dy } : x; }));
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
    setBinDragging(true);
    const clear = () => { setBinDragging(false); window.removeEventListener("dragend", clear); window.removeEventListener("drop", clear); };
    window.addEventListener("dragend", clear);
    window.addEventListener("drop", clear);
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

  // ===========================================================================
  // Editor AI agent: chat panel + tool executor. The /api/editor-agent route
  // plans; every action below runs through the SAME functions the UI uses,
  // so undo, versions and the section chain all behave normally.
  // ===========================================================================
  type AgentAction = { tool: string; args?: Record<string, unknown> };
  type AgentChip = { tool: string; ok: boolean; result: string };
  type AgentMsg = { role: "user" | "assistant" | "tool"; content: string; chips?: AgentChip[] };
  const [agentOpen, setAgentOpen] = useState(false);
  const [agentMsgs, setAgentMsgs] = useState<AgentMsg[]>(() => {
    try {
      const raw = localStorage.getItem(`${PROJECT_KEY}:agentchat`);
      const j = raw ? (JSON.parse(raw) as AgentMsg[]) : [];
      return Array.isArray(j) ? j.slice(-60) : [];
    } catch { return []; }
  });
  useEffect(() => {
    try { localStorage.setItem(`${PROJECT_KEY}:agentchat`, JSON.stringify(agentMsgs.slice(-60))); } catch { /* quota */ }
  }, [agentMsgs]);
  const [agentModel, setAgentModel] = useState<string>(() => {
    try { const m = localStorage.getItem("flowlab.agent.model"); if (m && LLM_MODELS.some((x) => x.id === m)) return m; } catch { /* */ }
    return "anthropic/claude-sonnet-4.6";
  });
  useEffect(() => { try { localStorage.setItem("flowlab.agent.model", agentModel); } catch { /* */ } }, [agentModel]);
  // urls that actually arrived through "Send to editor" from the canvas node -
  // persisted per project so the agent can tell canvas material apart even
  // after a reload.
  const canvasUrlsRef = useRef<Set<string>>(new Set());
  const canvasUrlsLoadedRef = useRef(false);
  const ensureCanvasUrlsLoaded = useCallback(() => {
    if (canvasUrlsLoadedRef.current) return;
    canvasUrlsLoadedRef.current = true;
    try {
      const raw = localStorage.getItem(`${PROJECT_KEY}:canvasUrls`);
      if (raw) { const arr = JSON.parse(raw) as string[]; if (Array.isArray(arr)) for (const u of arr) canvasUrlsRef.current.add(u); }
    } catch { /* */ }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const noteCanvasUrls = useCallback((urls: string[]) => {
    ensureCanvasUrlsLoaded();
    for (const u of urls) canvasUrlsRef.current.add(u);
    try { localStorage.setItem(`${PROJECT_KEY}:canvasUrls`, JSON.stringify(Array.from(canvasUrlsRef.current).slice(-400))); } catch { /* */ }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ensureCanvasUrlsLoaded]);
  const [agentInput, setAgentInput] = useState("");
  const [agentBusy, setAgentBusy] = useState(false);
  const agentEndRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => { agentEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [agentMsgs, agentBusy]);

  const agentBin = useCallback((): EditorAsset[] => {
    const seen = new Set<string>();
    const out: EditorAsset[] = [];
    for (const a of [...canvasAssets, ...library, ...brandLib]) {
      if (!a.url || seen.has(a.url)) continue;
      seen.add(a.url); out.push(a);
    }
    return out;
  }, [canvasAssets, library, brandLib]);

  // Compact editor snapshot for the model (kept small on purpose).
  const assetSrc = useCallback((a: EditorAsset): "canvas" | "generated" | "brand" => {
    ensureCanvasUrlsLoaded();
    if (canvasUrlsRef.current.has(a.url)) return "canvas";
    if (brandLib.some((b) => b.url === a.url)) return "brand";
    return "generated";
  }, [brandLib, ensureCanvasUrlsLoaded]);
  const buildAgentState = useCallback((): string => {
    const cl = clipsRef.current.map((c) => ({
      id: c.id, kind: c.kind, label: clipLabel(c).slice(0, 28), section: c.section,
      start: +c.start.toFixed(2), dur: +c.duration.toFixed(2), layer: c.layer,
      ...(c.kf?.length ? { keys: c.kf.length } : {}), ...(c.muted ? { muted: true } : {}),
    }));
    const ly = layersRef.current.map((l) => ({ id: l.id, type: l.type, ...(l.name ? { name: l.name } : {}), ...(l.hidden ? { hidden: true } : {}) }));
    const bin = agentBin().slice(0, 80).map((a) => ({ id: a.id, kind: a.kind, label: (a.label || "").slice(0, 30), src: assetSrc(a), ...(a.category ? { cat: a.category } : {}), ...(a.duration ? { dur: +a.duration.toFixed(1) } : {}) }));
    const cats = Array.from(new Set(brandLib.map((a) => a.category).filter(Boolean)));
    return JSON.stringify({
      format: resKey, timelineDur: +endOf(clipsRef.current).toFixed(2), playhead: +playheadRef.current.toFixed(2),
      layersTopFirst: ly, clips: cl,
      versions: { count: tlVersionsRef.current.length || 1, active: tlVersionsRef.current.length ? activeVerRef.current : 0 },
      selection: selectedRef.current, binCategories: cats, bin,
    });
  }, [clipLabel, agentBin, brandLib, resKey, assetSrc]);

  const agentFindAsset = useCallback((args: Record<string, unknown>): EditorAsset | null => {
    const id = typeof args.asset_id === "string" ? args.asset_id : null;
    const url = typeof args.url === "string" ? args.url : null;
    const pool = agentBin();
    if (id) { const hit = pool.find((a) => a.id === id); if (hit) return hit; }
    if (url) {
      const hit = pool.find((a) => a.url === url);
      if (hit) return hit;
      const kindGuess: EditorAsset["kind"] = /\.(mp3|wav|m4a|aac|ogg)(\?|$)/i.test(url) ? "audio" : /\.(png|jpe?g|webp|gif)(\?|$)/i.test(url) ? "image" : "video";
      return { id: url, url, kind: kindGuess, label: "found asset", duration: null };
    }
    return null;
  }, [agentBin]);

  // Execute ONE planned action; returns a short human/JSON result for the model.
  const executeAgentAction = useCallback(async (a: AgentAction): Promise<string> => {
    const args = a.args || {};
    const str = (k: string) => (typeof args[k] === "string" ? (args[k] as string) : undefined);
    const num = (k: string) => (typeof args[k] === "number" && isFinite(args[k] as number) ? (args[k] as number) : undefined);
    const clipOf = (k = "clip_id") => clipsRef.current.find((c) => c.id === str(k));
    switch (a.tool) {
      case "list_assets": {
        const kind = str("kind"); const cat = str("category"); const q = (str("query") || "").toLowerCase(); const src = str("source");
        const hits = agentBin().filter((x) =>
          (!kind || x.kind === kind) && (!cat || (x.category || "").toLowerCase() === cat.toLowerCase()) &&
          (!src || assetSrc(x) === src) &&
          (!q || (x.label || "").toLowerCase().includes(q) || (x.category || "").toLowerCase().includes(q))).slice(0, 30)
          .map((x) => ({ id: x.id, kind: x.kind, label: (x.label || "").slice(0, 30), src: assetSrc(x), cat: x.category, dur: x.duration ?? undefined }));
        return JSON.stringify({ assets: hits });
      }
      case "semantic_search": {
        const q = str("query"); if (!q) return "error: query required";
        const r = await fetch("/api/semantic-search", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: q, brandId: binBrand || undefined, modality: str("kind"), limit: 12 }) });
        const j = (await r.json()) as { results?: { assetId: string | null; url: string; modality: string; category: string | null }[]; error?: string };
        if (!r.ok) return `error: ${j.error || "search failed"}`;
        const res = (j.results || []).filter((x) => x.url).slice(0, 12).map((x) => ({ url: x.url, kind: x.modality, cat: x.category || undefined }));
        return JSON.stringify({ results: res });
      }
      case "add_clip": {
        const asset = agentFindAsset(args);
        if (!asset) return "error: asset not found (use list_assets / semantic_search first)";
        let layerId = str("layer_id");
        if (args.new_layer === true || (layerId && !layersRef.current.some((l) => l.id === layerId))) layerId = createLayerAt(0, clipLayerType(asset.kind));
        const before = new Set(clipsRef.current.map((c) => c.id));
        addAssetAt({ kind: asset.kind, url: asset.url, label: asset.label, duration: num("duration") ?? asset.duration }, layerId, num("start"));
        await new Promise((r) => setTimeout(r, 30));
        const added = clipsRef.current.find((c) => !before.has(c.id));
        if (added && str("section")) update(added.id, { section: str("section") });
        return added ? `added clip ${added.id} (${asset.kind} "${(asset.label || "").slice(0, 24)}") at ${added.start.toFixed(2)}s for ${added.duration.toFixed(2)}s` : "added (id unknown)";
      }
      case "add_text": {
        const text = str("text"); if (!text) return "error: text required";
        let lid = layersRef.current.find((l) => l.type === "text" && !/subtitle/i.test(l.name || ""))?.id;
        if (!lid) lid = createLayerAt(0, "text");
        const id = uid();
        const start = num("start") ?? playheadRef.current;
        setClips((prev) => [...prev, { id, kind: "text", layer: lid!, label: text.slice(0, 24), start: +start.toFixed(2), duration: num("duration") ?? 3, fadeIn: 0, fadeOut: 0, scale: 1, x: 0, y: num("y") ?? -0.25, text, tstyle: { color: "#ffffff", shadow: true, plate: "none", enter: "", weight: 800 } }]);
        return `added text clip ${id} ("${text.slice(0, 30)}") at ${start.toFixed(2)}s`;
      }
      case "replace_clip": {
        const c = clipOf(); if (!c) return "error: clip not found";
        const asset = agentFindAsset(args);
        if (!asset) return "error: replacement asset not found";
        const durKnown = asset.duration ?? frameCache.get(asset.url)?.dur;
        update(c.id, { url: asset.url, inset: 0, ...(durKnown && c.section && c.kind === "video" ? { duration: +durKnown.toFixed(2), autoDur: false } : { autoDur: true }) });
        return `replaced ${c.id} with "${(asset.label || asset.url).slice(0, 30)}"${c.section ? " (chain re-times)" : ""}`;
      }
      case "update_clip": {
        const c = clipOf(); if (!c) return "error: clip not found";
        const p = (args.patch || {}) as Record<string, unknown>;
        const patch: Partial<EditClip> = {};
        for (const k of ["start", "duration", "inset", "volume", "fadeIn", "fadeOut", "scale", "x", "y", "rot"] as const) {
          if (typeof p[k] === "number" && isFinite(p[k] as number)) (patch as Record<string, unknown>)[k] = p[k];
        }
        if (typeof p.muted === "boolean") patch.muted = p.muted;
        if (typeof p.text === "string") patch.text = p.text as string;
        if (typeof p.fit === "string" && ["cover", "contain", "blur"].includes(p.fit as string)) patch.fit = p.fit as EditClip["fit"];
        if (typeof p.transType === "string") patch.transType = p.transType as EditClip["transType"];
        if (!Object.keys(patch).length) return "error: empty/unknown patch";
        update(c.id, patch);
        return `updated ${c.id}: ${Object.keys(patch).join(", ")}`;
      }
      case "split_clip": {
        const c = clipOf(); const at = num("at");
        if (!c || at == null) return "error: clip/at required";
        splitOneAt(c.id, at);
        return `split ${c.id} at ${at.toFixed(2)}s`;
      }
      case "remove_clips": {
        const ids = Array.isArray(args.clip_ids) ? (args.clip_ids as unknown[]).filter((x): x is string => typeof x === "string") : [];
        if (!ids.length) return "error: clip_ids required";
        removeMany(ids);
        return `removed ${ids.length} clip(s)`;
      }
      case "add_keyframes": {
        const c = clipOf(); if (!c) return "error: clip not found";
        const raw = Array.isArray(args.keys) ? (args.keys as Record<string, unknown>[]) : [];
        const keys = raw.filter((k) => typeof k.t === "number").map((k) => ({
          t: +(k.t as number).toFixed(2),
          ...(typeof k.x === "number" ? { x: k.x as number } : {}), ...(typeof k.y === "number" ? { y: k.y as number } : {}),
          ...(typeof k.scale === "number" ? { scale: k.scale as number } : {}), ...(typeof k.rot === "number" ? { rot: k.rot as number } : {}),
        })).sort((x, y) => x.t - y.t);
        if (!keys.length) return "error: keys required";
        update(c.id, { kf: keys });
        return `set ${keys.length} keyframe(s) on ${c.id}`;
      }
      case "new_version": { addVersionFromCurrent(); return "created a new version (now active)"; }
      case "switch_version": {
        const i = num("index"); if (i == null) return "error: index required";
        switchVersion(i);
        return `switched to v${i + 1}`;
      }
      case "generate_versions": {
        const c = clipOf(); const cat = str("category");
        if (!c || !cat) return "error: clip_id/category required";
        const n = generateVersions(c.id, cat);
        return n ? `generated ${n} version(s) replacing ${c.section ?? c.id} with each "${cat}" asset` : "no new assets in that category";
      }
      case "add_subtitles": {
        const srcId = str("source_clip_id");
        void generateSubtitles(srcId); // long transcription - runs in background
        return "subtitles generation started (background, ~1-2 min); captions will land on the Subtitles layer";
      }
      case "set_format": {
        const key = str("key");
        if (!key || !RESOLUTIONS.some((r) => r.key === key)) return "error: unknown format";
        switchFormat(key);
        return `format set to ${key}`;
      }
      case "render": {
        const scope = str("scope") === "all" ? "all" : "current";
        const fmts = Array.isArray(args.formats) ? (args.formats as unknown[]).filter((x): x is string => typeof x === "string" && RESOLUTIONS.some((r) => r.key === x)) : [];
        const set = fmts.length ? new Set(fmts) : undefined;
        if (set) setBatchFormats(set);
        if (scope === "all") void renderVersions(null, set);
        else void renderVersions(tlVersionsRef.current.length ? activeVerRef.current : 0, set);
        return `render started (${scope}${set ? `, formats: ${fmts.join(", ")}` : ""}) - files download when ready`;
      }
      case "select": {
        const ids = Array.isArray(args.clip_ids) ? (args.clip_ids as unknown[]).filter((x): x is string => typeof x === "string") : [];
        setSelectedIds(ids.filter((id) => clipsRef.current.some((c) => c.id === id)));
        return `selected ${ids.length} clip(s)`;
      }
      case "seek": { const t = num("t"); if (t == null) return "error: t required"; seek(Math.max(0, t)); return `playhead at ${t.toFixed(2)}s`; }
      default: return `error: unknown tool "${a.tool}"`;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentBin, agentFindAsset, binBrand, assetSrc]);

  // Chat loop: plan -> execute -> (optionally) feed results back, max 4 rounds.
  const runAgent = useCallback(async (userText: string) => {
    if (agentBusy) return;
    setAgentBusy(true);
    const history: AgentMsg[] = [...agentMsgs, { role: "user", content: userText }];
    setAgentMsgs(history);
    try {
      let msgs = history;
      for (let round = 0; round < 4; round++) {
        const r = await fetch("/api/editor-agent", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: msgs.map(({ role, content }) => ({ role, content })), state: buildAgentState(), model: agentModel }),
        });
        const j = (await r.json()) as { reply?: string; actions?: AgentAction[]; continue?: boolean; error?: string };
        if (!r.ok) throw new Error(j.error || "agent request failed");
        const actions = j.actions || [];
        const chips: AgentChip[] = [];
        for (const act of actions) {
          try {
            const res = await executeAgentAction(act);
            chips.push({ tool: act.tool, ok: !res.startsWith("error"), result: res });
          } catch (e) {
            chips.push({ tool: act.tool, ok: false, result: e instanceof Error ? e.message : "failed" });
          }
        }
        const asstMsg: AgentMsg = { role: "assistant", content: JSON.stringify({ reply: j.reply, actions }), chips };
        msgs = [...msgs, asstMsg];
        setAgentMsgs((prev) => [...prev, { ...asstMsg, content: j.reply || "" }]);
        if (!(j.continue && actions.length) || round === 3) break;
        await new Promise((res) => setTimeout(res, 120)); // let state effects settle
        msgs = [...msgs, { role: "tool", content: chips.map((c) => `${c.tool}: ${c.result}`).join("\n") }];
      }
    } catch (e) {
      setAgentMsgs((prev) => [...prev, { role: "assistant", content: `Agent error: ${e instanceof Error ? e.message : "unknown"}` }]);
    } finally { setAgentBusy(false); }
  }, [agentBusy, agentMsgs, buildAgentState, executeAgentAction, agentModel]);

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
            <div role="button" tabIndex={0} draggable onDragStart={(e) => onBinDragStart(e, a)} onDragEnd={() => setBinDragging(false)} onClick={() => addAssetAt(a)} title={`${a.label}${extOf(a.url) ? ` · ${extOf(a.url)}` : ""}`}
              className="group relative w-full aspect-square rounded-md overflow-hidden bg-bg-card border border-border hover:border-brand cursor-grab active:cursor-grabbing">
              {a.kind === "image" ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={a.url} alt="" onLoad={(e) => noteDims(a.url, e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)} className="absolute inset-0 w-full h-full object-cover" loading="lazy" draggable={false} />
              ) : a.kind === "video" ? (
                <VideoThumb src={a.url} hoverPlay onDims={(w, h) => noteDims(a.url, w, h)} className="absolute inset-0 w-full h-full" />
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
    const tx = ((c.x || 0) + v.offX) * previewSize.w;
    const ty = ((c.y || 0) + v.offY) * previewSize.h;
    return {
      opacity: v.opacity,
      transform: `translate(${tx}px, ${ty}px) scale(${(c.scale || 1) * v.scaleMul})${c.rot ? ` rotate(${c.rot}deg)` : ""}`,
      transformOrigin: "center",
      clipPath: v.reveal != null ? `inset(0 ${Math.round((1 - v.reveal) * 100)}% 0 0)` : undefined,
    };
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

  // z-order (bottom → top) of all visual-layer clips — from viewClips so the
  // viewport shows the previewed VERSION (timeline lanes stay on base clips)
  const onLayerView = (id: string) => viewClips.filter((c) => c.layer === id).sort((a, b) => a.start - b.start);
  const zClips: EditClip[] = [];
  for (let i = visualLayers.length - 1; i >= 0; i--) { if (visualLayers[i].hidden) continue; zClips.push(...onLayerView(visualLayers[i].id)); }

  return (
    <div className="flex-1 flex min-h-0" onContextMenu={(e) => {
      const t = e.target as HTMLElement;
      if (t.closest("input,textarea,[contenteditable=true]")) return; // keep native paste menu in fields
      if (t.closest("[data-clip]")) return; // clips open their own menu
      e.preventDefault();
    }}>
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
            <div className="flex flex-wrap items-center gap-1 text-[10px]">
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
            <div className="flex flex-wrap items-center gap-1 text-[10px]">
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
            <button onClick={() => generateSubtitles()} disabled={subBusy || subSources.length === 0}
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
            <select value={resKey} onChange={(e) => switchFormat(e.target.value)} className="bg-bg-card border border-border rounded-md px-2 py-1 text-[11px] text-fg-muted outline-none">
              {RESOLUTIONS.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
            </select>
            <div className="relative">
              <button onClick={() => setNamingOpen((o) => !o)} title="Export file name"
                className="px-2 py-1 rounded border border-border text-[11px] text-fg-muted hover:text-fg hover:border-brand inline-flex items-center gap-1">
                <Tag size={12} /> Name
              </button>
              {namingOpen && (
                <div className="absolute right-0 top-full mt-1 z-50 w-[360px] rounded-lg border border-border bg-bg-card p-3 shadow-xl text-[11px]" onPointerDown={(e) => e.stopPropagation()}>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-fg font-medium">Export file name</span>
                    <button onClick={() => setNamingOpen(false)} className="text-fg-subtle hover:text-fg"><X size={13} /></button>
                  </div>
                  <label className="block text-fg-subtle mb-1">Template</label>
                  <input value={naming.template} onChange={(e) => setNaming((n) => ({ ...n, template: e.target.value }))}
                    className="w-full bg-bg-subtle border border-border rounded px-2 py-1 text-fg outline-none focus:border-brand mb-1 font-mono text-[10px]" />
                  <div className="flex flex-wrap gap-1 mb-2">
                    {NAMING_TOKENS.map((tk) => (
                      <button key={tk} onClick={() => setNaming((n) => ({ ...n, template: n.template + (n.template && !/[_{.-]$/.test(n.template) ? "_" : "") + `{${tk}}` }))}
                        className="px-1.5 py-0.5 rounded border border-dashed border-border text-fg-subtle hover:text-fg hover:border-brand text-[10px] font-mono">{`{${tk}}`}</button>
                    ))}
                  </div>
                  <div className="grid grid-cols-3 gap-2 mb-2">
                    <div><label className="block text-fg-subtle mb-0.5">Brand code</label><input value={naming.brandCode ?? ""} placeholder={guessBrandCode(brandName) || "RT"} onChange={(e) => setNaming((n) => ({ ...n, brandCode: e.target.value.replace(/[^A-Za-z0-9]/g, "").slice(0, 4).toUpperCase() }))} className="w-full bg-bg-subtle border border-border rounded px-2 py-1 text-fg outline-none focus:border-brand" /></div>
                    <div><label className="block text-fg-subtle mb-0.5">Version</label><input value={naming.version} onChange={(e) => setNaming((n) => ({ ...n, version: e.target.value.replace(/[^A-Za-z0-9-]/g, "").slice(0, 8) }))} className="w-full bg-bg-subtle border border-border rounded px-2 py-1 text-fg outline-none focus:border-brand" /></div>
                    <div><label className="block text-fg-subtle mb-0.5">Lang</label><input value={naming.lang} onChange={(e) => setNaming((n) => ({ ...n, lang: e.target.value.replace(/[^A-Za-z-]/g, "").slice(0, 5) }))} className="w-full bg-bg-subtle border border-border rounded px-2 py-1 text-fg outline-none focus:border-brand" /></div>
                    <div><label className="block text-fg-subtle mb-0.5">Initials</label><input value={naming.initials} onChange={(e) => setNaming((n) => ({ ...n, initials: e.target.value.replace(/[^A-Za-z0-9]/g, "").slice(0, 8) }))} placeholder="AA" className="w-full bg-bg-subtle border border-border rounded px-2 py-1 text-fg outline-none focus:border-brand" /></div>
                  </div>
                  {/* Live per-token breakdown - makes any junk in a field obvious at a glance */}
                  <div className="mb-2 rounded bg-bg-subtle/50 border border-border px-2 py-1.5 text-[10px] leading-relaxed">
                    <span className="text-fg-subtle">Tokens now: </span>
                    <span className="font-mono">{`{date}`}</span>=<span className="text-fg-muted">{namingDate()}</span>{" \u00b7 "}<span className="font-mono">{`{brand}`}</span>=<span className="text-fg-muted">{(naming.brandCode || guessBrandCode(brandName)) || "(empty)"}</span>{" \u00b7 "}<span className="font-mono">{`{project}`}</span>=<span className="text-fg-muted">{(projectName || "creative").trim()}</span>{" · "}
                    <span className="font-mono">{`{version}`}</span>=<span className="text-fg-muted">{naming.version || "v1"}</span>{" · "}
                    <span className="font-mono">{`{lang}`}</span>=<span className="text-fg-muted">{naming.lang || "en"}</span>{" · "}
                    <span className="font-mono">{`{initials}`}</span>=<span className="text-fg-muted">{naming.initials || "(empty)"}</span>
                  </div>
                  <div className="flex items-center justify-between mb-0.5">
                    <span className="text-fg-subtle">Preview</span>
                    <button onClick={() => setNaming({ ...NAMING_DEFAULT })} title="Restore the default template and fields" className="text-[10px] text-fg-subtle hover:text-brand underline decoration-dotted">Reset to default</button>
                  </div>
                  <div className="rounded bg-bg-subtle border border-border px-2 py-1.5 text-brand font-mono text-[10px] break-all">{buildFileName("mp4")}</div>
                  <div className="text-fg-subtle mt-2 text-[10px]">{projectName ? <>Base <span className="text-fg-muted">{`{project}`}</span> = {projectName}</> : "Open from a project so {project} fills in automatically."}</div>
                </div>
              )}
            </div>
            <div className="relative">
              <button onClick={() => setAgentOpen((o) => !o)} title="AI agent: tell it what to do with the timeline"
                className={`px-2 py-1 rounded border text-[11px] inline-flex items-center gap-1 ${agentOpen ? "border-brand text-brand bg-brand/10" : "border-border text-fg-muted hover:text-fg hover:border-brand"}`}>
                <Sparkles size={12} /> Agent
              </button>
              <button onClick={() => setVersionsOpen((o) => !o)} title="Variants & batch render"
                className="px-2 py-1 rounded border border-border text-[11px] text-fg-muted hover:text-fg hover:border-brand inline-flex items-center gap-1">
                <Layers size={12} /> Versions
              </button>
              {versionsOpen && (() => {
                const allVers: TLSnapshot[] = tlVersions.length ? tlVersions : [{ id: "cur", name: "", clips, layers }];
                const replaceable = clips.filter((c) => (c.kind === "video" || c.kind === "image") && c.url).sort((a, b) => a.start - b.start);
                const cats = Array.from(new Set(brandLib.map((a) => a.category).filter(Boolean))) as string[];
                const fmtsChecked = RESOLUTIONS.filter((r) => batchFormats.has(r.key)).length;
                const total = allVers.length * fmtsChecked;
                const exFmt = RESOLUTIONS.find((r) => batchFormats.has(r.key))?.key;
                return (
                  <div className="absolute right-0 top-full mt-1 z-50 w-[440px] max-h-[72vh] overflow-auto rounded-lg border border-border bg-bg-card p-3 shadow-xl text-[11px]" onPointerDown={(e) => e.stopPropagation()}>
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-fg font-medium">Versions</span>
                      <button onClick={() => setVersionsOpen(false)} className="text-fg-subtle hover:text-fg"><X size={13} /></button>
                    </div>
                    <div className="mb-2 rounded-md bg-bg-subtle/60 border border-border px-2 py-1.5 text-[10px] text-fg-subtle leading-relaxed">
                      Every version is a full timeline. Edit whatever you like (add clips, replace, delete, text), press <span className="text-fg-muted">+</span> to snapshot the current state as a new version and keep going. Tabs under the player switch between them.
                    </div>

                    <div className="space-y-0.5 mb-2">
                      {allVers.map((v, vi) => (
                        <div key={v.id} onClick={() => switchVersion(vi)}
                          className={`flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer border ${(tlVersions.length ? activeVer : 0) === vi ? "bg-brand/10 border-brand/40" : "border-transparent hover:bg-bg-subtle"}`}>
                          <span className={`w-7 shrink-0 ${(tlVersions.length ? activeVer : 0) === vi ? "text-brand font-medium" : "text-fg-subtle"}`}>v{vi + 1}</span>
                          <span className="flex-1 truncate text-fg-muted" title={describeSnap(v)}>{vi === 0 ? `base \u00b7 ${describeSnap(v)}` : describeSnap(v)}</span>
                          <button title="Render only this version (in the checked formats)" onClick={(e) => { e.stopPropagation(); renderOneVersion(vi); }} className="text-fg-subtle hover:text-brand shrink-0"><Download size={12} /></button>
                          {tlVersions.length > 0 && <button title="Duplicate this version" onClick={(e) => { e.stopPropagation(); duplicateVersion(vi); }} className="text-fg-subtle hover:text-fg shrink-0"><Copy size={12} /></button>}
                          {tlVersions.length > 1 && <button title="Delete this version" onClick={(e) => { e.stopPropagation(); deleteVersion(vi); }} className="text-fg-subtle hover:text-red-400 shrink-0"><X size={12} /></button>}
                        </div>
                      ))}
                    </div>
                    <button onClick={addVersionFromCurrent}
                      className="mb-3 px-2 py-1 rounded border border-dashed border-border text-fg-subtle hover:text-brand hover:border-brand inline-flex items-center gap-1"><Plus size={11} /> New version (snapshot of the current timeline)</button>

                    {replaceable.length > 0 && brandLib.length > 0 && (
                      <div className="mb-3 rounded-md border border-border bg-bg-subtle/40 px-2 py-2">
                        <div className="text-fg mb-1">Generate versions from the bin</div>
                        <div className="text-[10px] text-fg-subtle mb-1.5">One new version per asset, replacing the chosen clip in a copy of the current timeline:</div>
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <select value={genClip} onChange={(e) => setGenClip(e.target.value)} className="bg-bg-subtle border border-border rounded px-2 py-1 text-fg outline-none focus:border-brand max-w-[150px]">
                            {replaceable.map((c) => <option key={c.id} value={c.id}>{c.section ?? clipLabel(c)}</option>)}
                          </select>
                          <select value={genCat} onChange={(e) => setGenCat(e.target.value)} className="bg-bg-subtle border border-border rounded px-2 py-1 text-fg outline-none focus:border-brand">
                            {cats.map((ct) => <option key={ct} value={ct}>{ct}</option>)}
                            <option value="all">any asset</option>
                          </select>
                          <button onClick={() => { const cid = genClip || replaceable[0]?.id; if (!cid) return; const n = generateVersions(cid, genCat); setStatus(n ? `${n} version${n === 1 ? "" : "s"} generated.` : "Nothing new to add from that category."); }}
                            className="px-2 py-1 rounded bg-brand text-black font-medium">Generate</button>
                        </div>
                      </div>
                    )}

                    <div className="mt-1 mb-1.5 text-fg">Formats to render:</div>
                    <div className="flex items-center gap-3 mb-2">
                      {RESOLUTIONS.map((r) => (
                        <label key={r.key} className="inline-flex items-center gap-1 cursor-pointer text-fg-muted">
                          <input type="checkbox" checked={batchFormats.has(r.key)} onChange={(e) => setBatchFormats((p) => { const n = new Set(p); if (e.target.checked) n.add(r.key); else n.delete(r.key); return n; })} className="accent-[rgb(var(--brand))]" />
                          {r.key}
                        </label>
                      ))}
                    </div>
                    <div className={`mb-2 text-[10px] leading-relaxed ${total > 24 ? "text-amber-400" : "text-fg-subtle"}`}>
                      This renders <span className="font-medium">{total}</span> separate file{total === 1 ? "" : "s"} ({allVers.length} version{allVers.length === 1 ? "" : "s"} &times; {fmtsChecked} format{fmtsChecked === 1 ? "" : "s"}), named by your template.
                      {total > 24 && <span> That is a lot &mdash; delete versions or formats if you only need a few.</span>}
                      {exFmt && <div className="mt-1 truncate text-fg-subtle">Name example: <span className="text-fg-muted">{buildFileName("mp4", `v${(tlVersions.length ? activeVer : 0) + 1}`, exFmt)}</span></div>}
                    </div>
                    <button disabled={batchRunning || exporting} onClick={renderAllVersions}
                      className="w-full py-1.5 rounded-md bg-brand text-black font-medium disabled:opacity-50 inline-flex items-center justify-center gap-1.5">
                      <Download size={13} /> Render all versions
                    </button>
                  </div>
                );
              })()}
            </div>
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
          onPointerDown={onPanDown}>
                    {altNotice && altNotice.length > 0 && (() => {
            const counts = new Map<string, number>();
            for (const a of altNotice) counts.set(a.category || "other", (counts.get(a.category || "other") || 0) + 1);
            const parts = Array.from(counts.entries()).map(([k, n]) => `${k} +${n}`).join(", ");
            let combos = 1;
            for (const n of counts.values()) combos *= n + 1;
            combos = Math.min(12, combos - 1);
            return (
              <div className="absolute top-3 left-1/2 -translate-x-1/2 z-40 flex items-center gap-3 px-3 py-2 rounded-lg bg-bg-card border border-brand/50 shadow-xl text-[12px] max-w-[92%]">
                <span className="text-fg">
                  {altNotice.length} alternate clip{altNotice.length === 1 ? "" : "s"} from the canvas landed in the bin ({parts}) {"\u2014"} the timeline keeps one per section.
                </span>
                <button onClick={() => { const n = buildComboVersions(altNotice); setAltNotice(null); if (n) flashStatus(`${n} version${n === 1 ? "" : "s"} created \u2014 switch with the tabs under the player.`, 6000); }}
                  className="px-2.5 py-1 rounded-md bg-brand text-black font-medium shrink-0">Create {combos} version{combos === 1 ? "" : "s"}</button>
                <button onClick={() => setAltNotice(null)} className="text-fg-subtle hover:text-fg shrink-0"><X size={13} /></button>
              </div>
            );
          })()}
{(() => {
            const hooks = brandLib.filter((a) => a.category === "hook" && (a.kind === "video" || a.kind === "image"));
            const hookUrls = new Set(hooks.map((h) => h.url));
            const placedHook = clips.find((c) => c.url != null && hookUrls.has(c.url));
            const others = hooks.filter((h) => h.url !== placedHook?.url).length;
            const hasSlot = tlVersions.length > 0;
            // Only nudge when the user has actually placed a hook on the timeline
            // AND there are other hooks to turn into versions. Avoids popping up
            // at random moments.
            if (altNotice || !placedHook || others < 1 || hasSlot || hookBannerDismissed) return null;
            return (
              <div className="absolute top-3 left-1/2 -translate-x-1/2 z-30 flex items-center gap-3 px-3 py-2 rounded-lg bg-bg-card border border-brand/40 shadow-xl text-[12px]">
                <span className="text-fg"><span className="text-brand font-medium">{others + 1} hook versions</span> available {"\u2014"} build them automatically?</span>
                <button onClick={buildHookVersions} className="px-2.5 py-1 rounded-md bg-brand text-black font-medium text-[11px] whitespace-nowrap">Build versions</button>
                <button onClick={() => setHookBannerDismissed(true)} className="text-fg-subtle hover:text-fg" aria-label="Dismiss"><X size={14} /></button>
              </div>
            );
          })()}
          {tlVersions.length > 0 && (
            <div className="absolute top-3 right-3 z-30 flex items-center gap-1 px-1.5 py-1 rounded-lg bg-bg-card/95 border border-border shadow-lg text-[11px]" title="Each version is a full editable timeline">
              <button onClick={() => switchVersion((activeVer - 1 + tlVersions.length) % tlVersions.length)} className="w-6 h-6 grid place-items-center rounded text-fg-muted hover:text-fg hover:bg-bg-subtle" aria-label="Previous version"><ChevronLeft size={13} /></button>
              <button onClick={() => setVersionsOpen(true)} className="px-1.5 py-0.5 rounded hover:bg-bg-subtle" title={tlVersions[activeVer] ? describeSnap(tlVersions[activeVer]) : ""}>
                <span className="text-brand font-medium">v{activeVer + 1}</span>
                <span className="text-fg-subtle">/{tlVersions.length}</span>
              </button>
              <button onClick={() => switchVersion((activeVer + 1) % tlVersions.length)} className="w-6 h-6 grid place-items-center rounded text-fg-muted hover:text-fg hover:bg-bg-subtle" aria-label="Next version"><ChevronRight size={13} /></button>
            </div>
          )}
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
                      const fitMode = c.fit ?? (c.kind === "video" ? "cover" : "contain");
                      const objFit = fitMode === "cover" ? "object-cover" : "object-contain";
                      const blurBg = fitMode === "blur";
                      // Full-frame box: size the clip by its NATURAL dimensions
                      // (cover = scale up, never crop), so moving/scaling shows
                      // the rest of the frame - only the canvas clips it. This
                      // matches the export math exactly. Falls back to the old
                      // object-fit path until dims are known / during wipes /
                      // for chroma-keyed clips.
                      const dims = clipDimsRef.current.get(c.id);
                      const boxMode = !!dims && !c.keyColor && v.reveal == null && fitMode !== "blur";
                      let boxStyle: React.CSSProperties | null = null;
                      if (boxMode && dims) {
                        const W = previewSize.w, H = previewSize.h;
                        const ks = kfState(c, t - c.start); // keyframed transform (falls back to static values)
                        const ratio = fitMode === "cover" ? Math.max(W / dims.w, H / dims.h) : Math.min(W / dims.w, H / dims.h);
                        const fitPx = ratio * ks.scale * v.scaleMul;
                        const bw = dims.w * fitPx, bh = dims.h * fitPx;
                        boxStyle = {
                          left: (W - bw) / 2 + (ks.x + v.offX) * W,
                          top: (H - bh) / 2 + (ks.y + v.offY) * H,
                          width: bw, height: bh,
                          opacity: v.opacity,
                          transform: ks.rot ? `rotate(${ks.rot}deg)` : undefined,
                          transformOrigin: "center",
                        };
                      }
                      // Only load a clip's video near its playback window, so the
                      // whole timeline's videos don't buffer/decode all at once.
                      const near = active || (c.start - t > 0 && c.start - t < 1.5) || (t >= c.start + c.duration && t - (c.start + c.duration) < 0.4);
                      return (
                        <div key={c.id} className={boxStyle ? "absolute" : "absolute inset-0"}
                          style={{ ...(boxStyle ?? styleFromVisual(c, v)), mixBlendMode: (c.blend || undefined) as React.CSSProperties["mixBlendMode"], pointerEvents: active ? "auto" : "none", cursor: "move", touchAction: "none" }}
                          onPointerDown={(e) => onVpDown(e, c, "move")} onContextMenu={(e) => onClipContext(e, c)}>
                          {blurBg && c.kind === "image" && !c.keyColor && (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={c.url} alt="" draggable={false} className="absolute inset-0 w-full h-full object-cover pointer-events-none" style={{ filter: "blur(22px)", transform: "scale(1.08)" }} />
                          )}
                          {c.kind === "image" && !c.keyColor && (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={c.url} alt="" draggable={false} onLoad={(e) => noteClipDims(c.id, e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)} className={`absolute inset-0 w-full h-full ${boxStyle ? "object-fill" : objFit} pointer-events-none`} />
                          )}
                          {c.kind === "image" && c.keyColor && <KeyedImage url={c.url!} keyColor={c.keyColor} keyTol={c.keyTol ?? 0.3} />}
                          {blurBg && active && c.kind === "video" && !c.keyColor && (
                            <video src={c.url} muted playsInline preload="metadata" ref={(el) => { if (el) mediaRefs.current.set(c.id + "::bg", el); else mediaRefs.current.delete(c.id + "::bg"); }}
                              className="absolute inset-0 w-full h-full object-cover pointer-events-none" style={{ filter: "blur(22px)", transform: "scale(1.08)" }} />
                          )}
                          {c.kind === "video" && !c.keyColor && (
                            <video src={near || c.autoDur ? c.url : undefined} playsInline preload={active ? "auto" : "metadata"} onLoadedMetadata={(e) => { onMeta(c.id, e.currentTarget.duration); noteClipDims(c.id, e.currentTarget.videoWidth, e.currentTarget.videoHeight); }} ref={(el) => { if (el) mediaRefs.current.set(c.id, el); else mediaRefs.current.delete(c.id); }}
                              className={`absolute inset-0 w-full h-full ${boxStyle ? "object-fill" : objFit} pointer-events-none`} />
                          )}
                          {c.kind === "video" && c.keyColor && (
                            <KeyedVideo url={c.url!} keyColor={c.keyColor} keyTol={c.keyTol ?? 0.3}
                              register={(el) => { if (el) mediaRefs.current.set(c.id, el); else mediaRefs.current.delete(c.id); }}
                              onMeta={(d) => onMeta(c.id, d)} />
                          )}
                          {isSel && active && <div className="absolute inset-0 ring-2 ring-brand pointer-events-none" />}
                          {selected === c.id && active && (
                            <>
                              <div onPointerDown={(e) => onVpDown(e, c, "scale")} className="absolute bottom-1 right-1 w-3.5 h-3.5 bg-brand rounded-sm cursor-nwse-resize" style={{ touchAction: "none" }} />
                              {(c.kind === "video" || c.kind === "image") && (
                                <div onPointerDown={(e) => onVpDown(e, c, "rotate")} title="Drag to rotate (Shift = 15 deg steps)"
                                  className="absolute left-1/2 -translate-x-1/2 -top-6 w-4 h-4 rounded-full bg-bg-card border-2 border-brand cursor-grab active:cursor-grabbing shadow" style={{ touchAction: "none" }}>
                                  <div className="absolute left-1/2 top-full -translate-x-1/2 w-px h-2.5 bg-brand/70" />
                                </div>
                              )}
                            </>)}
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
              {viewClips.filter((c) => c.kind === "audio").map((c) => (
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
          <button onClick={() => setCutMode((m) => !m)} title={cutMode ? "Cut tool ON - click a clip where you want to split it (Esc to exit); S still splits at the playhead" : "Cut tool: click, then click a clip where you want to split it. S = split at playhead"} className={`rounded px-1 -mx-1 ${cutMode ? "text-brand bg-brand/15 ring-1 ring-brand/50" : "hover:text-fg"}`}><Scissors size={13} /></button>
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
        {tlVersions.length > 0 && (
          <div className="shrink-0 border-t border-border bg-bg-card/60 pl-2 pr-3 h-8 flex items-center gap-1.5 overflow-x-auto whitespace-nowrap text-[11px]">
            <span className="text-fg-subtle mr-0.5 shrink-0">Versions:</span>
            {tlVersions.map((v, vi) => (
              <button key={v.id} onClick={() => switchVersion(vi)}
                title={describeSnap(v)}
                className={`group px-2 py-0.5 rounded-md border shrink-0 inline-flex items-center gap-1 ${activeVer === vi ? "bg-brand/15 border-brand text-brand font-medium" : "border-border text-fg-muted hover:text-fg hover:border-border-strong"}`}>
                v{vi + 1}
                {tlVersions.length > 1 && <span onClick={(e) => { e.stopPropagation(); deleteVersion(vi); }} title="Delete this version" className="opacity-0 group-hover:opacity-100 text-fg-subtle hover:text-red-400"><X size={10} /></span>}
              </button>
            ))}
            <button onClick={addVersionFromCurrent}
              title="Snapshot the current timeline as a new version" className="px-1.5 py-0.5 rounded-md border border-dashed border-border text-fg-subtle hover:text-brand hover:border-brand shrink-0"><Plus size={11} /></button>
            <span className="ml-2 text-fg-subtle truncate hidden sm:inline">editing v{activeVer + 1} {"\u2014"} every change stays in this version</span>
          </div>
        )}
        <div ref={timelineWheelRef} className={`shrink-0 border-t border-border overflow-auto bg-bg-card/30 select-none ${cutMode ? "cursor-crosshair" : ""}`} style={{ height: timelineH }}
          onPointerDown={onMarqueeDown} onPointerMove={onClipPointerMove} onPointerUp={onClipPointerUp} onPointerLeave={onClipPointerUp}>
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
                    className={`flex-1 rounded transition-all grid place-items-center overflow-hidden ${dropHint?.type === "strip" && dropHint.id === `strip-${li}` ? "h-5 bg-brand/25 ring-1 ring-brand" : (binDragging || clipDragging) ? "h-3 bg-brand/10 ring-1 ring-dashed ring-brand/40" : "h-0.5 bg-border/30"}`}>
                    {((binDragging || clipDragging) || (dropHint?.type === "strip" && dropHint.id === `strip-${li}`)) && (
                      <span className={`pointer-events-none inline-flex items-center gap-1 text-[9px] leading-none ${dropHint?.type === "strip" && dropHint.id === `strip-${li}` ? "text-brand font-medium" : "text-brand/70"}`}><Plus size={9} /> New layer</span>
                    )}
                  </div>
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
                        {(c.kf?.length ?? 0) > 0 && c.kf!.map((k, ki) => (
                          <span key={ki} title={`transform key @ ${k.t.toFixed(2)}s - click: jump, Alt+click: delete`}
                            onPointerDown={(e) => { e.stopPropagation(); if (e.altKey) update(c.id, { kf: c.kf!.length > 1 ? c.kf!.filter((_, j) => j !== ki) : undefined }); else seek(c.start + k.t); }}
                            className="absolute bottom-0.5 w-2 h-2 rotate-45 bg-amber-400 border border-black/50 cursor-pointer z-[3] hover:scale-125 transition-transform"
                            style={{ left: Math.max(1, k.t * pxPerSec - 4) }} />
                        ))}
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
                            style={{ left: b.start * pxPerSec - 12, display: (clipDragging || binDragging) ? "none" : undefined }} title="Transition"
                            className="absolute top-0 h-full z-40 grid place-items-center w-6 group opacity-45 hover:opacity-100 transition-opacity">
                            <span className={`grid place-items-center w-5 h-5 rounded-full text-[11px] leading-none border shadow-sm ${b.transType ? "bg-amber-400 text-black border-amber-200" : "bg-bg-card/95 text-fg-muted border-border group-hover:border-brand group-hover:text-brand"}`}>
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
                      className={`flex-1 rounded transition-all grid place-items-center overflow-hidden ${dropHint?.type === "strip" && dropHint.id === `strip-${li + 1}` ? "h-5 bg-brand/25 ring-1 ring-brand" : (binDragging || clipDragging) ? "h-3 bg-brand/10 ring-1 ring-dashed ring-brand/40" : "h-0.5 bg-border/30"}`}>
                    {((binDragging || clipDragging) || (dropHint?.type === "strip" && dropHint.id === `strip-${li + 1}`)) && (
                      <span className={`pointer-events-none inline-flex items-center gap-1 text-[9px] leading-none ${dropHint?.type === "strip" && dropHint.id === `strip-${li + 1}` ? "text-brand font-medium" : "text-brand/70"}`}><Plus size={9} /> New layer</span>
                    )}
                  </div>
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
      <aside style={{ width: rightW, display: rightW === 0 ? "none" : undefined }} className="relative shrink-0 flex flex-col min-h-0 border-l border-[rgb(var(--hairline)/var(--hairline-alpha))] bg-[rgb(var(--glass-tint)/0.82)] backdrop-blur-2xl">
        <div onPointerDown={dragPanel("right")} className="absolute top-0 -left-1 w-2 h-full cursor-col-resize z-20 hover:bg-brand/30" title="Drag to resize" />
        <div className="h-11 shrink-0 border-b border-[rgb(var(--hairline)/var(--hairline-alpha))] flex items-center justify-between px-3 text-[13px] font-semibold text-fg">Properties
          <button onClick={() => setRightW(0)} title="Hide panel" className="text-fg-subtle hover:text-fg w-6 h-6 flex items-center justify-center rounded-md hover:bg-bg-hover">›</button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto p-2.5 text-[11px]">
          {!sel && <div className="text-fg-subtle p-2">Select a clip on the timeline or in the viewport to edit its properties.</div>}
          {sel && (
            <div className="flex flex-col gap-2.5">
              <div className="flex items-center justify-between">
                <span className="text-fg-subtle uppercase tracking-wider text-[10px]">{sel.kind}</span>
                <div className="flex gap-2">
                  <button onClick={() => duplicate(sel.id)} title="Duplicate" className="text-fg-muted hover:text-fg"><Copy size={12} /></button>
                  <button onClick={() => remove(sel.id)} title="Delete" className="text-red-400 hover:text-red-300"><Trash2 size={13} /></button>
                </div>
              </div>

              <Section id="basic" title="Basic" open={openSec.basic} onToggle={toggleSec}>
                <input value={sel.label} onChange={(e) => update(sel.id, { label: e.target.value })} className="w-full bg-bg-card border border-border rounded px-2 py-1 text-fg outline-none focus:border-brand" placeholder="Name" />
                {sel.kind === "text" && (<textarea value={sel.text ?? ""} onChange={(e) => update(sel.id, { text: e.target.value })} rows={2} className="w-full bg-bg-card border border-border rounded px-2 py-1 text-fg outline-none focus:border-brand resize-y" placeholder="Text" />)}
                {sel.kind === "text" && (
                  <div className="space-y-1">
                    <div className="text-fg-muted">Alignment</div>
                    <div className="grid grid-cols-3 gap-1">
                      {([["left", "Left"], ["center", "Center"], ["right", "Right"]] as const).map(([v, l]) => (
                        <button key={v} onClick={() => { const ids = selectedRef.current.length > 1 ? new Set(selectedRef.current) : new Set([sel.id]); setClips((p) => p.map((c) => (c.kind === "text" && ids.has(c.id) ? { ...c, tstyle: { ...(c.tstyle || {}), align: v as TextStyle["align"] } } : c))); }}
                          className={`px-1 py-1 rounded border text-[10px] ${(sel.tstyle?.align || "center") === v ? "border-brand bg-brand/10 text-brand" : "border-border text-fg-muted hover:border-brand/50"}`}>{l}</button>
                      ))}
                    </div>
                    <div className="text-fg-muted pt-1">Entrance animation</div>
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
              </Section>

              <Section id="timing" title="Timing" open={openSec.timing} onToggle={toggleSec}>
                <div className="grid grid-cols-2 gap-1.5">
                  <label className="flex items-center gap-1 text-fg-muted">start<input type="number" min={0} step={0.1} value={sel.start} onChange={(e) => update(sel.id, { start: Math.max(0, Number(e.target.value) || 0) })} className="flex-1 min-w-0 bg-bg-card border border-border rounded px-1.5 py-1 text-fg outline-none focus:border-brand" /></label>
                  <label className="flex items-center gap-1 text-fg-muted">dur<input type="number" min={MIN_DUR} step={0.1} value={sel.duration} onChange={(e) => update(sel.id, { duration: Math.max(MIN_DUR, Number(e.target.value) || MIN_DUR) })} className="flex-1 min-w-0 bg-bg-card border border-border rounded px-1.5 py-1 text-fg outline-none focus:border-brand" /></label>
                  <label className="flex items-center gap-1 text-fg-muted">fade in<input type="number" min={0} step={0.1} value={sel.fadeIn} onChange={(e) => update(sel.id, { fadeIn: Math.max(0, Number(e.target.value) || 0) })} className="flex-1 min-w-0 bg-bg-card border border-border rounded px-1.5 py-1 text-fg outline-none focus:border-brand" /></label>
                  <label className="flex items-center gap-1 text-fg-muted">fade out<input type="number" min={0} step={0.1} value={sel.fadeOut} onChange={(e) => update(sel.id, { fadeOut: Math.max(0, Number(e.target.value) || 0) })} className="flex-1 min-w-0 bg-bg-card border border-border rounded px-1.5 py-1 text-fg outline-none focus:border-brand" /></label>
                </div>
              </Section>

              {(sel.kind === "video" || sel.kind === "image" || sel.kind === "text") && (
                <Section id="transform" title="Transform & motion" open={openSec.transform} onToggle={toggleSec}>
                  <label className="flex items-center gap-2 text-fg-muted">scale<input type="range" min={0.2} max={3} step={0.05} value={sel.scale} onChange={(e) => updateSel(sel.id, { scale: Number(e.target.value) })} className="flex-1" /><span className="w-9 text-right tabular-nums">{Math.round(sel.scale * 100)}%</span></label>
                  {(sel.kind === "video" || sel.kind === "image") && (
                    <label className="flex items-center gap-2 text-fg-muted">rotate<input type="range" min={-180} max={180} step={1} value={sel.rot ?? 0} onChange={(e) => updateSel(sel.id, { rot: Number(e.target.value) })} onDoubleClick={() => updateSel(sel.id, { rot: 0 })} className="flex-1" /><span className="w-9 text-right tabular-nums">{Math.round(sel.rot ?? 0)}&deg;</span></label>
                  )}
                  {(sel.kind === "video" || sel.kind === "image") && (() => {
                    const local = +(Math.min(Math.max(playhead - sel.start, 0), sel.duration)).toFixed(2);
                    const near = (sel.kf || []).find((k) => Math.abs(k.t - local) < 0.05);
                    const cur = kfState(sel, local);
                    return (
                      <div className="flex items-center gap-2 text-fg-muted">
                        <span>keys</span>
                        <button title={near ? "Update the keyframe at the playhead with the current transform" : "Add a transform keyframe (x/y/scale/rotate) at the playhead"}
                          onClick={() => {
                            const key = { t: local, x: cur.x, y: cur.y, scale: cur.scale, rot: cur.rot };
                            updateSel(sel.id, { kf: [...(sel.kf || []).filter((k) => Math.abs(k.t - local) >= 0.05), key].sort((a, b) => a.t - b.t) });
                          }}
                          className={`w-5 h-5 grid place-items-center rounded border ${near ? "border-brand text-brand bg-brand/15" : "border-border text-fg-subtle hover:text-brand hover:border-brand"}`}>
                          <span className="block w-2 h-2 rotate-45 border border-current" style={{ background: near ? "currentColor" : "transparent" }} />
                        </button>
                        <span className="text-fg-subtle text-[10px] flex-1">{(sel.kf?.length ?? 0)} key{(sel.kf?.length ?? 0) === 1 ? "" : "s"} {"\u00b7"} diamonds on the clip: click = jump, Alt+click = delete</span>
                        {(sel.kf?.length ?? 0) > 0 && <button onClick={() => updateSel(sel.id, { kf: undefined })} className="text-fg-subtle hover:text-red-400 text-[10px] underline decoration-dotted">clear</button>}
                      </div>
                    );
                  })()}
                  <label className="flex items-center gap-2 text-fg-muted">animation<select value={sel.anim ?? ""} onChange={(e) => update(sel.id, { anim: e.target.value })} className="flex-1 bg-bg-card border border-border rounded px-1.5 py-1 text-fg outline-none">{ANIMS.map((a) => <option key={a.v} value={a.v}>{a.l}</option>)}</select></label>
                  <button onClick={() => resetTransform(sel.id)} className="text-[10px] text-fg-subtle hover:text-fg underline underline-offset-2">Reset position & scale</button>
                </Section>
              )}

              {(sel.kind === "video" || sel.kind === "image") && (
                <Section id="background" title="Background & chroma" open={openSec.background} onToggle={toggleSec}>
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
                </Section>
              )}
              {sel.kind === "video" && (
                <Section id="sr" title="Screen replace" open={openSec.sr} onToggle={toggleSec} right={
                  !sel.sr ? (
                    <button type="button" onClick={() => updateSel(sel.id, { sr: { green: sel.url || "", key: "#00FF00", sim: 0.3, fit: "fill" } })} className="px-2 py-0.5 rounded-md border border-border text-[10px] text-fg-muted hover:text-fg">Enable</button>
                  ) : (
                    <button type="button" onClick={() => updateSel(sel.id, { sr: undefined })} className="px-2 py-0.5 rounded-md border border-border text-[10px] text-fg-muted hover:text-fg">Off</button>
                  )
                }>
                  {sel.sr && (
                    <div className="space-y-1.5">
                      <div className="text-[10px] text-fg-subtle leading-snug">Replace this green-screen phone screen with content. Rendered on the server — node-quality keying, despill, matte and corner-pin tracking.</div>
                      <div className="space-y-1">
                        <div className="flex items-center gap-1.5 text-fg-muted">
                          <span className="whitespace-nowrap">content</span>
                          <button type="button" onClick={() => setSrPicker((v) => !v)} className="flex-1 min-w-0 bg-bg-card border border-border rounded px-1.5 py-1 text-left text-fg text-[11px] truncate hover:border-brand/50">
                            {sel.sr.content
                              ? (library.find((a) => a.url === sel.sr!.content)?.label || clips.find((c) => c.url === sel.sr!.content)?.label || "Selected content")
                              : "Pick content…"}
                          </button>
                        </div>
                        {srPicker && (() => {
                          const tl = clips.filter((c) => (c.kind === "image" || c.kind === "video") && c.url && c.id !== sel.id);
                          const media = library.filter((a) => a.kind === "image" || a.kind === "video");
                          const pick = (url?: string, isVid?: boolean) => { updateSel(sel.id, { sr: { ...sel.sr!, content: url, contentVideo: isVid } }); setSrPicker(false); };
                          const tile = (url: string, label: string, isVid: boolean, on: boolean, key: string) => (
                            <button key={key} type="button" onClick={() => pick(url, isVid)} className={`relative rounded overflow-hidden border aspect-square bg-black ${on ? "border-brand ring-1 ring-brand" : "border-border hover:border-brand/50"}`} title={label}>
                              {isVid
                                ? <VideoThumb src={url} className="w-full h-full pointer-events-none" />
                                : /* eslint-disable-next-line @next/next/no-img-element */ <img src={url} alt="" loading="lazy" className="w-full h-full object-cover pointer-events-none" />}
                              <span className="absolute inset-x-0 bottom-0 bg-black/65 text-white text-[8px] leading-tight px-1 py-0.5 truncate">{label}</span>
                            </button>
                          );
                          return (
                            <div className="border border-border rounded-md p-1.5 bg-bg-card/60 max-h-56 overflow-y-auto space-y-1.5">
                              {tl.length > 0 && (
                                <div className="space-y-1">
                                  <div className="text-[10px] text-fg-subtle px-0.5">From timeline</div>
                                  <div className="grid grid-cols-3 gap-1">{tl.map((c) => tile(c.url!, c.label, c.kind === "video", sel.sr!.content === c.url, c.id))}</div>
                                </div>
                              )}
                              <div className="space-y-1">
                                <div className="text-[10px] text-fg-subtle px-0.5">Media</div>
                                {media.length > 0
                                  ? <div className="grid grid-cols-3 gap-1">{media.slice(0, 60).map((a) => tile(a.url, a.label, a.kind === "video", sel.sr!.content === a.url, a.id))}</div>
                                  : <div className="text-[10px] text-fg-subtle px-0.5">No media yet — upload in the Media panel.</div>}
                              </div>
                            </div>
                          );
                        })()}
                      </div>
                      <div className="grid grid-cols-2 gap-1.5">
                        <label className="flex items-center gap-1 text-fg-muted">fit
                          <select value={sel.sr.fit ?? "fill"} onChange={(e) => updateSel(sel.id, { sr: { ...sel.sr!, fit: e.target.value as "fill" | "cover" } })} className="flex-1 bg-bg-card border border-border rounded px-1 py-1 text-fg outline-none">
                            <option value="fill">Fill</option><option value="cover">Cover</option>
                          </select>
                        </label>
                        <label className="flex items-center gap-1 text-fg-muted">key
                          <select value={String(sel.sr.sim ?? 0.3)} onChange={(e) => updateSel(sel.id, { sr: { ...sel.sr!, sim: Number(e.target.value) } })} className="flex-1 bg-bg-card border border-border rounded px-1 py-1 text-fg outline-none">
                            <option value="0.2">Tight</option><option value="0.3">Normal</option><option value="0.45">Loose</option>
                          </select>
                        </label>
                      </div>
                      <label className="flex items-center gap-2 text-fg-muted">matte<input type="range" min={-8} max={8} step={1} value={sel.sr.matte ?? 0} onChange={(e) => updateSel(sel.id, { sr: { ...sel.sr!, matte: Number(e.target.value) } })} className="flex-1" /><span className="w-9 text-right tabular-nums">{sel.sr.matte ?? 0}px</span></label>
                      <label className="flex items-center gap-2 text-fg-muted">soften<input type="range" min={0} max={8} step={1} value={sel.sr.feather ?? 0} onChange={(e) => updateSel(sel.id, { sr: { ...sel.sr!, feather: Number(e.target.value) } })} className="flex-1" /><span className="w-9 text-right tabular-nums">{sel.sr.feather ?? 0}px</span></label>
                      {(() => { const t = sel.sr.green ? srTrackCache[sel.sr.green] : null; const txt = t === "loading" ? "Tracking screen…" : t === "error" ? "Auto-track failed — opens fresh" : t ? "Track ready" : ""; return txt ? <div className="text-[10px] text-fg-subtle flex items-center gap-1">{t === "loading" && <Loader2 size={11} className="animate-spin" />}{txt}</div> : null; })()}
                      <div className="flex gap-1.5">
                        <button type="button" onClick={() => setTrackOpen(true)} className="flex-1 px-2 py-1.5 rounded-md border border-border text-[11px] text-fg-muted hover:text-fg inline-flex items-center justify-center gap-1.5"><SlidersHorizontal size={13} /> Adjust track</button>
                        <button type="button" onClick={renderSR} disabled={srBusy || !sel.sr.content} className="flex-1 px-2 py-1.5 rounded-md bg-brand text-white text-[11px] font-medium disabled:opacity-50 inline-flex items-center justify-center gap-1.5">{srBusy ? (<><Loader2 size={13} className="animate-spin" /> Replacing…</>) : (<><Wand2 size={13} /> Replace screen</>)}</button>
                      </div>
                      {srErr && <div className="text-[10px] text-red-400">{srErr}</div>}
                      <div className="text-[10px] text-fg-subtle leading-snug">After Render the clip plays the finished composite. Tweak the track / params and Render again to update.</div>
                    </div>
                  )}
                </Section>
              )}

              {(sel.kind === "video" || sel.kind === "audio") && (
                <Section id="audio" title="Audio" open={openSec.audio} onToggle={toggleSec}>
                  <label className="flex items-center gap-2 text-fg-muted">volume<input type="range" min={0} max={3} step={0.05} value={sel.volume ?? 1} onChange={(e) => updateSel(sel.id, { volume: Number(e.target.value) })} disabled={!!sel.muted} className="flex-1 disabled:opacity-40" /><span className="w-10 text-right tabular-nums">{Math.round((sel.volume ?? 1) * 100)}%</span></label>
                  <label className="flex items-center gap-1.5 text-fg-muted"><input type="checkbox" checked={!!sel.muted} onChange={(e) => updateSel(sel.id, { muted: e.target.checked })} /> Mute</label>
                </Section>
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
        const isVisualMedia = c.kind === "video" || c.kind === "image";
        return (
          <div className="fixed z-50 w-52 glass menu-solid r-md p-1.5 text-[11px]" style={{ left: Math.min(menu.x, window.innerWidth - 220), top: Math.max(8, Math.min(menu.y, window.innerHeight - 500)) }} onClick={(e) => e.stopPropagation()}>
            {isMedia && (
              <>
                <div className="px-1.5 py-1 text-fg-subtle uppercase tracking-wider text-[9px]">Animation</div>
                <div className="grid grid-cols-2 gap-1 px-1 pb-1.5">
                  {ANIMS.map((a) => (<button key={a.v} onClick={() => apply({ anim: a.v })} className={`px-1.5 py-1 rounded text-left ${(c.anim ?? "") === a.v ? "bg-brand/20 text-brand" : "hover:bg-white/5 text-fg-muted"}`}>{a.l}</button>))}
                </div>
              </>
            )}
            {isVisualMedia && (
              <>
                <div className="px-1.5 py-1 text-fg-subtle uppercase tracking-wider text-[9px]">Fit (per format)</div>
                <div className="grid grid-cols-3 gap-1 px-1 pb-1.5">
                  {([["cover", "Fill"], ["contain", "Fit"], ["blur", "Blur bg"]] as const).map(([val, lbl]) => {
                    const cur = c.fit ?? (c.kind === "video" ? "cover" : "contain");
                    return <button key={val} onClick={() => apply({ fit: val })} className={`px-1.5 py-1 rounded ${cur === val ? "bg-brand/20 text-brand" : "hover:bg-white/5 text-fg-muted"}`}>{lbl}</button>;
                  })}
                </div>
              </>
            )}
            {(isMedia || c.kind === "audio") && (
              <>
                <div className="px-1.5 py-1 text-fg-subtle uppercase tracking-wider text-[9px]">Versions</div>
                <div className="px-1 pb-1.5">
                  {(c.kind === "video" || c.kind === "image") && (
                    <button onClick={() => { setReplaceFor(menu.id); setMenu(null); }} className="w-full px-1.5 py-1 rounded hover:bg-white/5 text-fg-muted text-left">
                      Replace asset{tlVersions.length ? ` (edits v${activeVer + 1})` : ""}\u2026
                    </button>
                  )}
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
          <div className="fixed z-50 w-44 glass menu-solid r-md p-1.5 text-[11px]" style={{ left: Math.min(transMenu.x, window.innerWidth - 190), top: Math.max(8, Math.min(transMenu.y, window.innerHeight - 320)) }} onClick={(e) => e.stopPropagation()}>
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
      {agentOpen && (
        <div className="fixed bottom-4 right-4 z-[70] w-[360px] max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-bg-card shadow-2xl flex flex-col text-[12px]" style={{ maxHeight: "min(560px, 72vh)" }}>
          <div className="flex items-center justify-between px-3 py-2 border-b border-border shrink-0">
            <span className="inline-flex items-center gap-1.5 text-fg font-medium"><Sparkles size={13} className="text-brand" /> Agent</span>
            <select value={agentModel} onChange={(e) => setAgentModel(e.target.value)} title="Model that plans the actions (GPT/Gemini use your direct API keys)"
              className="max-w-[150px] bg-bg-subtle border border-border rounded px-1.5 py-0.5 text-[10px] text-fg-muted outline-none focus:border-brand">
              {LLM_MODELS.map((m) => <option key={m.id} value={m.id}>{m.label.replace(" (text only)", "")}</option>)}
            </select>
            <div className="flex items-center gap-2">
              {agentMsgs.length > 0 && <button onClick={() => setAgentMsgs([])} title="Clear the conversation" className="text-fg-subtle hover:text-fg text-[10px] underline decoration-dotted">clear</button>}
              <button onClick={() => setAgentOpen(false)} className="text-fg-subtle hover:text-fg"><X size={14} /></button>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto px-3 py-2 space-y-2 min-h-[120px]">
            {agentMsgs.length === 0 && (
              <div className="text-fg-subtle text-[11px] leading-relaxed py-2">
                I can operate the whole editor: find footage (semantic search), assemble Hook/Body/Packshot cuts, add text and subtitles, animate with keyframes, manage versions and render. Try:
                <div className="mt-1.5 space-y-1">
                  {["Make a version for every hook in the bin", "Find footage about the app UI and build a 15s ad with subtitles", "Add a punchy hook text at the start and fade all clips 0.2s"].map((ex) => (
                    <button key={ex} onClick={() => { if (!agentBusy) void runAgent(ex); }} className="block w-full text-left px-2 py-1 rounded border border-border/60 text-fg-muted hover:border-brand hover:text-fg">{ex}</button>
                  ))}
                </div>
              </div>
            )}
            {agentMsgs.filter((m) => m.role !== "tool").map((m, i) => (
              <div key={i} className={m.role === "user" ? "flex justify-end" : "flex justify-start"}>
                <div className={`max-w-[92%] rounded-lg px-2.5 py-1.5 leading-relaxed ${m.role === "user" ? "bg-brand/15 text-fg" : "bg-bg-subtle text-fg"}`}>
                  <div className="whitespace-pre-wrap break-words">{m.content}</div>
                  {m.chips && m.chips.some((ch) => !ch.ok) && (
                    <div className="mt-1 text-[10px] text-red-400/90">{m.chips.filter((ch) => !ch.ok).map((ch) => `${ch.tool}: ${ch.result}`).join("; ")}</div>
                  )}
                </div>
              </div>
            ))}
            {agentBusy && <div className="flex items-center gap-2 text-fg-subtle"><span className="w-3 h-3 rounded-full border border-border border-t-brand animate-spin" /> working{"\u2026"}</div>}
            <div ref={agentEndRef} />
          </div>
          <div className="p-2 border-t border-border shrink-0 flex items-end gap-1.5">
            <textarea value={agentInput} onChange={(e) => setAgentInput(e.target.value)} rows={2} placeholder={"Tell the agent what to do\u2026"}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); const v = agentInput.trim(); if (v && !agentBusy) { setAgentInput(""); void runAgent(v); } } }}
              className="flex-1 resize-none bg-bg-subtle border border-border rounded-lg px-2 py-1.5 text-fg outline-none focus:border-brand" />
            <button disabled={agentBusy || !agentInput.trim()} onClick={() => { const v = agentInput.trim(); if (v) { setAgentInput(""); void runAgent(v); } }}
              className="px-2.5 py-1.5 rounded-lg bg-brand text-black font-medium disabled:opacity-50">Go</button>
          </div>
        </div>
      )}
      {replaceFor && (() => {
        const c = clips.find((x) => x.id === replaceFor);
        if (!c) return null;
        const pool = Array.from(new Map([...assets, ...brandLib].filter((a) => a.kind === c.kind && a.url && a.url !== c.url).map((a) => [a.url, a])).values())
          .sort((a, b) => Number(((b.category || "").toLowerCase() === (c.section || "").toLowerCase() && !!c.section)) - Number(((a.category || "").toLowerCase() === (c.section || "").toLowerCase() && !!c.section)));
        return (
          <div className="fixed inset-0 z-[80] bg-black/50 grid place-items-center" onClick={() => setReplaceFor(null)}>
            <div className="w-[520px] max-h-[70vh] overflow-auto rounded-xl border border-border bg-bg-card p-3 shadow-2xl text-[11px]" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center justify-between mb-2">
                <span className="text-fg font-medium">Replace {c.section ?? clipLabel(c)}{tlVersions.length ? ` (in v${activeVer + 1})` : ""}</span>
                <button onClick={() => setReplaceFor(null)} className="text-fg-subtle hover:text-fg"><X size={13} /></button>
              </div>
              {pool.length === 0 && <div className="text-fg-subtle py-4 text-center">No matching {c.kind} assets in the bin.</div>}
              <div className="grid grid-cols-4 gap-1.5">
                {pool.map((a) => (
                  <button key={a.id} title={a.label}
                    onClick={() => {
                      const durKnown = a.duration ?? frameCache.get(a.url)?.dur;
                      update(c.id, { url: a.url, inset: 0, ...(durKnown && c.section && c.kind === "video" ? { duration: +durKnown.toFixed(2), autoDur: false } : { autoDur: true }) });
                      setReplaceFor(null);
                    }}
                    className="relative rounded overflow-hidden border border-border hover:border-brand aspect-square bg-black/20">
                    {a.kind === "image"
                      // eslint-disable-next-line @next/next/no-img-element
                      ? <img src={a.url} alt="" className="absolute inset-0 w-full h-full object-cover" loading="lazy" />
                      : <VideoThumb src={a.url} className="absolute inset-0 w-full h-full" />}
                    <span className="absolute bottom-0 inset-x-0 bg-black/60 text-white text-[8px] px-1 py-0.5 truncate">{a.label}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        );
      })()}
      {trackOpen && sel && sel.sr?.green && (
        <TrackEditor
          source={sel.sr.green}
          value={sel.sr.keys ?? []}
          cachedTrack={(() => { const t = srTrackCache[sel.sr!.green]; return t && typeof t !== "string" ? t : undefined; })()}
          initialMode={sel.sr.mode}
          onSave={(keys, mode) => updateSel(sel.id, { sr: { ...sel.sr!, keys, mode } })}
          onClose={() => setTrackOpen(false)}
        />
      )}
    </div>
  );
}
