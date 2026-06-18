"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X, Play, Expand, Move } from "lucide-react";
import { NODE_TYPES, type FieldDef, type GraphNode } from "@/lib/canvas/types";
import { NodeIcon } from "@/lib/canvas/icons";
import Lightbox from "./Lightbox";
import SceneBuilder, { type Scene } from "./SceneBuilder";
import VideoGenControls from "./VideoGenControls";
import TrackEditor, { type TrackKey } from "./TrackEditor";

export default function NodeExpandedModal({
  node,
  isRunning,
  onClose,
  onConfigChange,
  onRun,
  sourceVideoUrl,
  cachedTrackUrl,
}: {
  node: GraphNode;
  isRunning: boolean;
  onClose: () => void;
  onConfigChange: (key: string, value: unknown) => void;
  onRun: () => void;
  sourceVideoUrl?: string;
  cachedTrackUrl?: string;
}) {
  const [mounted, setMounted] = useState(false);
  const [trackOpen, setTrackOpen] = useState(false);
  const parseTrackKeys = (v: unknown): TrackKey[] => {
    if (typeof v !== "string" || !v.trim()) return [];
    try { const a = JSON.parse(v); return Array.isArray(a) ? a : []; } catch { return []; }
  };
  useEffect(() => setMounted(true), []);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [onClose]);

  const def = NODE_TYPES[node.type];
  if (!def || !mounted) return null;

  const color = CAT_COLORS[def.category] ?? "#71717a";

  const content = (
    <div className="fixed inset-0 z-[1000] flex items-center justify-center p-4 animate-fade-in">
      {/* Close only on a real mousedown that STARTS on the backdrop. Using
          mousedown (not click) avoids the phantom click a native <select>
          dispatches after its dropdown closes, which used to shut the modal. */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onMouseDown={onClose} />
      <div
        className="relative bg-bg-card border border-border rounded-xl w-full max-w-4xl max-h-[90vh] flex flex-col md:flex-row overflow-hidden shadow-panel animate-fade-up"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <button
          onClick={onClose}
          className="absolute top-3 right-3 z-10 w-8 h-8 rounded-md flex items-center justify-center text-fg-muted hover:bg-bg-hover hover:text-fg"
        >
          <X size={16} strokeWidth={1.5} />
        </button>

        {/* Main column */}
        <div className="flex-1 min-w-0 border-r border-border flex flex-col">
          <div className="px-5 py-4 border-b border-border flex items-center gap-3">
            <span
              className="w-7 h-7 rounded-md flex items-center justify-center"
              style={{ background: `${color}20`, color }}
            >
              <NodeIcon name={def.icon} size={14} />
            </span>
            <div className="flex-1 min-w-0">
              <div className="text-[15px] font-medium text-fg leading-tight">{def.name}</div>
              <div className="text-[11px] text-fg-muted mt-0.5">{def.description}</div>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-5 space-y-4">
            {/* Multi-shot scene builder takes over the primary area when
                videoGen.mode === "multi-shot". The instructions textarea
                makes no sense here — the user authors per-scene prompts
                in the builder below, and the runner packs them into
                Kling's native multi_prompt field. */}
            {node.type === "videoGen" && node.config.mode === "multi-shot" ? (
              <SceneBuilder
                scenes={(node.config.scenes as Scene[] | undefined) ?? []}
                onChange={(next) => onConfigChange("scenes", next)}
              />
            ) : (
              def.primaryField && (
                <div>
                  <label className="block text-[10px] uppercase tracking-wider text-fg-muted font-medium mb-2">
                    {def.primaryLabel ?? "Instructions"}
                  </label>
                  <textarea
                    className="w-full bg-bg-subtle border border-border rounded-md px-3 py-3 text-[13px] text-fg outline-none focus:border-brand resize-y min-h-[160px] leading-relaxed"
                    placeholder={def.primaryPlaceholder ?? "Write text…"}
                    value={(node.config[def.primaryField] as string) ?? ""}
                    onChange={(e) => onConfigChange(def.primaryField!, e.target.value)}
                  />
                </div>
              )
            )}

            {/* Examples & starters */}
            {(def.examples?.length || def.starters?.length) && (
              <div className="space-y-3">
                {def.examples?.length ? (
                  <div>
                    <div className="text-[10px] uppercase tracking-wider text-fg-muted font-medium mb-2">
                      Try an example
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {def.examples.map((ex) => (
                        <button
                          key={ex}
                          onClick={() => def.primaryField && onConfigChange(def.primaryField, ex)}
                          className="px-3 py-1 rounded-full text-[11px] bg-bg-subtle border border-border hover:border-border-strong text-fg-muted hover:text-fg"
                        >
                          {ex}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}
                {def.starters?.length ? (
                  <div>
                    <div className="text-[10px] uppercase tracking-wider text-fg-muted font-medium mb-2">
                      Start with
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {def.starters.map((s) => (
                        <button
                          key={s}
                          onClick={() => def.primaryField && onConfigChange(def.primaryField, s)}
                          className="px-3 py-1 rounded-full text-[11px] bg-bg-subtle border border-border hover:border-border-strong text-fg-muted hover:text-fg"
                        >
                          {s}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            )}

            {/* Last output preview */}
            {node.outputs && Object.keys(node.outputs).length > 0 && (
              <div>
                <div className="text-[10px] uppercase tracking-wider text-fg-muted font-medium mb-2">
                  Last output
                </div>
                <BigPreview outputs={node.outputs} results={node.results} />
              </div>
            )}
          </div>
        </div>

        {/* Side panel — Settings */}
        <div className="w-full md:w-72 bg-bg-subtle p-5 overflow-y-auto flex flex-col">
          <h3 className="text-[13px] font-medium text-fg mb-4">Settings</h3>

          {node.type === "screenReplace" && (
            <button
              type="button"
              onClick={() => setTrackOpen(true)}
              disabled={!sourceVideoUrl}
              className="mb-4 inline-flex items-center justify-center gap-1.5 w-full px-3 py-2 rounded-md bg-brand text-white hover:bg-brand/90 text-[12px] font-medium disabled:opacity-50 disabled:cursor-not-allowed"
              title={sourceVideoUrl ? "Drag the screen to fix the track, set keyframes" : "Connect a source video first"}
            >
              <Move size={14} /> Adjust track visually
            </button>
          )}

          <div className="flex-1 space-y-4">
            {node.type === "videoGen" ? (
              <>
                <VideoGenControls config={node.config} onConfigChange={onConfigChange} size="large" />
                {/* aspect is the one generic field kept here (Kling V3 i2v ignores it) */}
                {def.fields.filter((f) => f.name === "aspect").map((f) => (
                  <SettingsField key={f.name} field={f} value={node.config[f.name]} onChange={(v) => onConfigChange(f.name, v)} />
                ))}
              </>
            ) : (
              <>
                {def.fields.map((f) => (
                  <SettingsField
                    key={f.name}
                    field={f}
                    value={node.config[f.name]}
                    onChange={(v) => onConfigChange(f.name, v)}
                  />
                ))}
                {def.fields.length === 0 && (
                  <div className="text-[11px] text-fg-subtle italic">No settings for this node.</div>
                )}
              </>
            )}
          </div>

          {def.outputs.length > 0 && (
            <button
              onClick={onRun}
              disabled={isRunning}
              className="w-full mt-4 bg-fg text-bg rounded-md py-2.5 text-[12px] font-medium flex items-center justify-center gap-2 hover:opacity-90 disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <Play size={12} fill="currentColor" />
              {isRunning ? "Running…" : "Run"}
            </button>
          )}
        </div>
      </div>
    </div>
  );

  return createPortal(
    <>
      {content}
      {trackOpen && node.type === "screenReplace" && sourceVideoUrl && (
        <TrackEditor
          source={sourceVideoUrl}
          cachedTrackUrl={cachedTrackUrl}
          initialMode={node.config.track_mode as "region" | "keys" | "anchor" | undefined}
          value={parseTrackKeys(node.config.track_keys)}
          onSave={(keys, mode) => { onConfigChange("track_keys", JSON.stringify(keys)); onConfigChange("track_mode", mode); }}
          onClose={() => setTrackOpen(false)}
        />
      )}
    </>,
    document.body,
  );
}

const CAT_COLORS: Record<string, string> = {
  text: "#3b82f6",
  image: "#10b981",
  video: "#ec4899",
  audio: "#f97316",
  structural: "#8b5cf6",
  integration: "#a855f7",
  tools: "#facc15",
};

function SettingsField({
  field,
  value,
  onChange,
}: {
  field: FieldDef;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  return (
    <div>
      <label className="block text-[10px] uppercase tracking-wider text-fg-muted font-medium mb-1">
        {field.label}
      </label>
      {field.help && (
        <p className="text-[10.5px] leading-snug text-fg-subtle mb-1.5">{field.help}</p>
      )}
      {field.type === "select" && (
        <div className="relative">
          <select
            className="appearance-none w-full bg-bg-card border border-border rounded-md pl-2.5 pr-7 py-2 text-[12px] text-fg outline-none focus:border-brand cursor-pointer"
            value={String(value ?? "")}
            onChange={(e) => onChange(e.target.value)}
          >
            {field.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <svg
            viewBox="0 0 24 24"
            className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 w-3 h-3 text-fg-muted"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </div>
      )}
      {field.type === "number" && (
        <input
          type="number"
          min={field.min}
          max={field.max}
          step={field.step}
          value={Number(value ?? 0)}
          onChange={(e) => onChange(Number(e.target.value))}
          className="w-full bg-bg-card border border-border rounded-md px-2.5 py-2 text-[12px] text-fg outline-none focus:border-brand"
        />
      )}
      {field.type === "text" && (
        <input
          type="text"
          placeholder={"placeholder" in field ? field.placeholder : undefined}
          value={(value as string) ?? ""}
          onChange={(e) => onChange(e.target.value)}
          className="w-full bg-bg-card border border-border rounded-md px-2.5 py-2 text-[12px] text-fg outline-none focus:border-brand"
        />
      )}
      {field.type === "textarea" && (
        <textarea
          rows={field.rows ?? 3}
          placeholder={field.placeholder}
          value={(value as string) ?? ""}
          onChange={(e) => onChange(e.target.value)}
          className="w-full bg-bg-card border border-border rounded-md px-2.5 py-2 text-[12px] text-fg outline-none focus:border-brand resize-none"
        />
      )}
      {field.type === "textarea-mono" && (
        <textarea
          rows={5}
          placeholder={field.placeholder}
          value={(value as string) ?? ""}
          onChange={(e) => onChange(e.target.value)}
          className="w-full bg-bg-card border border-border rounded-md px-2.5 py-2 text-[11px] text-fg outline-none focus:border-brand resize-none font-mono"
        />
      )}
      {field.type === "toggle" && (
        <button
          onClick={() => onChange(!value)}
          className={`w-10 h-5 rounded-full transition ${value ? "bg-brand" : "bg-border-strong"}`}
        >
          <span
            className={`block w-4 h-4 rounded-full bg-white transition-transform mx-0.5 ${
              value ? "translate-x-5" : "translate-x-0"
            }`}
          />
        </button>
      )}
      {field.type === "slider" && (() => {
        const num = Number(value ?? field.min);
        const atMin = num <= field.min + 1e-9;
        const display = field.minLabel && atMin ? field.minLabel : `${num}${field.unit ?? ""}`;
        return (
          <div className="flex items-center gap-2.5">
            <input
              type="range"
              min={field.min}
              max={field.max}
              step={field.step}
              value={num}
              onChange={(e) => onChange(Number(e.target.value))}
              className="flex-1 h-1.5 accent-brand cursor-pointer"
            />
            <span className="text-[11px] tabular-nums text-fg-muted min-w-[44px] text-right">{display}</span>
          </div>
        );
      })()}
    </div>
  );
}

function BigPreview({
  outputs,
  results,
}: {
  outputs: Record<string, unknown>;
  results?: { value: string; mime?: string }[];
}) {
  const [lightbox, setLightbox] = useState<{ src: string; kind: "image" | "video" } | null>(null);
  const list =
    results && results.length > 0
      ? results
      : Object.entries(outputs)
          .filter(([k, v]) => typeof v === "string" && k !== "track_url" && !k.startsWith("_"))
          .map(([, v]) => ({ value: v as string }));
  if (list.length === 0) return null;
  return (
    <div className={`grid ${list.length === 1 ? "grid-cols-1 justify-items-center" : "grid-cols-2"} gap-2`}>
      {list.map((r, i) => (
        <div key={i} className={`rounded-md bg-bg-card border border-border overflow-hidden relative group/cell ${list.length === 1 ? "w-fit max-w-full" : ""}`}>
          {isVideo(r.value) ? (
            <>
              <video src={r.value} controls className={`${list.length === 1 ? "max-w-full" : "w-full"} max-h-[80vh] object-contain block`} />
              <button
                type="button"
                onClick={() => setLightbox({ src: r.value, kind: "video" })}
                className="absolute top-2 right-2 w-7 h-7 rounded-md bg-black/60 hover:bg-black/80 text-white flex items-center justify-center opacity-0 group-hover/cell:opacity-100 transition-opacity backdrop-blur-sm"
                title="View fullscreen"
              >
                <Expand size={13} />
              </button>
            </>
          ) : isAudio(r.value) ? (
            <audio src={r.value} controls className="w-full" />
          ) : isImage(r.value) ? (
            <button
              type="button"
              onClick={() => setLightbox({ src: r.value, kind: "image" })}
              className={`block ${list.length === 1 ? "w-fit max-w-full" : "w-full"} cursor-zoom-in`}
              title="Click to view fullscreen"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={r.value} alt="" className={`${list.length === 1 ? "max-w-full" : "w-full"} max-h-[80vh] object-contain block`} />
            </button>
          ) : (
            <div className="relative group/expandedtext">
              <button
                type="button"
                onClick={() => void navigator.clipboard.writeText(String(r.value))}
                className="absolute top-2 right-2 px-2 py-0.5 rounded text-[10px] text-fg-muted bg-bg-card border border-border opacity-0 group-hover/expandedtext:opacity-100 transition-opacity hover:text-fg z-10"
                title="Copy full text"
              >
                Copy
              </button>
              <div className="p-3 pr-14 text-[12px] font-mono whitespace-pre-wrap break-words text-fg max-h-[60vh] overflow-auto leading-relaxed">
                {String(r.value)}
              </div>
            </div>
          )}
        </div>
      ))}
      {lightbox && (
        <Lightbox
          src={lightbox.src}
          kind={lightbox.kind}
          onClose={() => setLightbox(null)}
        />
      )}
    </div>
  );
}

function isImage(url: string) {
  return /\.(jpe?g|png|webp|gif)/i.test(url) || url.startsWith("data:image");
}
function isVideo(url: string) {
  return /\.(mp4|webm|mov)/i.test(url);
}
function isAudio(url: string) {
  return /\.(mp3|wav|m4a|ogg)/i.test(url);
}
