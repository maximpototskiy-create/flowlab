"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X, Play } from "lucide-react";
import { NODE_TYPES, type FieldDef, type GraphNode } from "@/lib/canvas/types";
import { NodeIcon } from "@/lib/canvas/icons";

export default function NodeExpandedModal({
  node,
  isRunning,
  onClose,
  onConfigChange,
  onRun,
}: {
  node: GraphNode;
  isRunning: boolean;
  onClose: () => void;
  onConfigChange: (key: string, value: unknown) => void;
  onRun: () => void;
}) {
  const [mounted, setMounted] = useState(false);
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
    <div
      className="fixed inset-0 z-[1000] flex items-center justify-center p-4 animate-fade-in"
      onClick={onClose}
    >
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div
        className="relative bg-bg-card border border-border rounded-xl w-full max-w-4xl max-h-[90vh] flex flex-col md:flex-row overflow-hidden shadow-panel animate-fade-up"
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
            {/* Primary instructions */}
            {def.primaryField && (
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

          <div className="flex-1 space-y-4">
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

  return createPortal(content, document.body);
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
      <label className="block text-[10px] uppercase tracking-wider text-fg-muted font-medium mb-1.5">
        {field.label}
      </label>
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
  const list =
    results && results.length > 0
      ? results
      : Object.values(outputs)
          .filter((v) => typeof v === "string")
          .map((v) => ({ value: v as string }));
  if (list.length === 0) return null;
  return (
    <div className="grid grid-cols-2 gap-2">
      {list.map((r, i) => (
        <div key={i} className="rounded-md bg-bg-card border border-border overflow-hidden">
          {isVideo(r.value) ? (
            <video src={r.value} controls className="w-full" />
          ) : isAudio(r.value) ? (
            <audio src={r.value} controls className="w-full" />
          ) : isImage(r.value) ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={r.value} alt="" className="w-full" />
          ) : (
            <div className="p-2 text-[11px] font-mono whitespace-pre-wrap break-words text-fg">
              {String(r.value).slice(0, 400)}
            </div>
          )}
        </div>
      ))}
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
