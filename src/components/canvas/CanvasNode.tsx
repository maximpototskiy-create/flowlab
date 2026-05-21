"use client";

import { useState, memo } from "react";
import { ChevronDown, Info, MoreHorizontal, Play, Maximize2, X, AlertCircle } from "lucide-react";
import { NODE_TYPES, type GraphNode, type FieldDef } from "@/lib/canvas/types";
import { NodeIcon } from "@/lib/canvas/icons";
import UploadZone from "./UploadZone";

export const NODE_WIDTH = 280;
export const NODE_HEADER_HEIGHT = 38;
export const NODE_PORT_SPACING = 26;

export function getNodeHeight(node: GraphNode): number {
  // Rough — actual height is determined by content. We use 200 as a baseline for edge routing.
  // Real heights come from DOM measurement during render.
  return 240;
}

export function portYOffset(node: GraphNode, portId: string, side: "in" | "out"): number {
  const def = NODE_TYPES[node.type];
  if (!def) return NODE_HEADER_HEIGHT;
  const list = side === "in" ? def.inputs : def.outputs;
  const idx = list.findIndex((p) => p.name === portId);
  if (idx < 0) return NODE_HEADER_HEIGHT;
  return NODE_HEADER_HEIGHT + 14 + idx * NODE_PORT_SPACING;
}

function CanvasNodeImpl({
  node,
  isSelected,
  isRunning,
  onPointerDown,
  onOutputPortDown,
  onInputPortUp,
  onSelect,
  onDelete,
  onConfigChange,
  onRun,
  onStop,
  onExpand,
  onUploadFile,
  workflowMeta,
}: {
  node: GraphNode;
  isSelected: boolean;
  isRunning: boolean;
  onPointerDown: (e: React.PointerEvent) => void;
  onOutputPortDown: (portId: string, e: React.PointerEvent) => void;
  onInputPortUp: (portId: string, e: React.PointerEvent) => void;
  onSelect: () => void;
  onDelete: () => void;
  onConfigChange: (key: string, value: unknown) => void;
  onRun: () => void;
  onStop?: () => void;
  onExpand: () => void;
  onUploadFile: (file: File) => Promise<{ cdnUrl: string }>;
  workflowMeta: { brandId: string | null; projectId: string; workflowId: string };
}) {
  const def = NODE_TYPES[node.type];
  if (!def) return null;

  const status = node.status ?? "idle";
  const color = node.type ? CAT_COLORS[def.category] : "#71717a";
  const [selectedResultIdx, setSelectedResultIdx] = useState(0);

  return (
    <div
      data-node-id={node.id}
      className={`absolute group select-none rounded-xl border bg-bg-card shadow-node ${
        status === "running"
          ? "border-amber-400 shadow-[0_0_0_2px_rgb(251_191_36_/_0.35)]"
          : status === "error"
          ? "border-red-400 shadow-[0_0_0_2px_rgb(239_68_68_/_0.25)]"
          : isSelected
          ? "border-brand shadow-[0_0_0_2px_rgb(var(--brand)/0.3)]"
          : "border-border hover:border-border-strong"
      }`}
      style={{
        top: 0,
        left: 0,
        width: NODE_WIDTH,
        transform: `translate(${node.position.x}px, ${node.position.y}px)`,
        willChange: "transform",
      }}
      onClick={(e) => {
        e.stopPropagation();
        onSelect();
      }}
    >
      {/* Header — colored top */}
      <div
        className="h-9 px-3 flex items-center gap-2 cursor-move rounded-t-xl border-b border-border"
        style={{ background: `${color}15` }}
        onPointerDown={onPointerDown}
      >
        <NodeIcon name={def.icon} className="shrink-0" size={13} style={{ color }} />
        <span className="text-[12px] font-medium text-fg truncate flex-1">{def.name}</span>

        <StatusDot status={status} />

        <button
          className="w-5 h-5 rounded flex items-center justify-center text-fg-subtle hover:text-fg hover:bg-bg-hover"
          title={def.description}
          onMouseDown={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <Info size={11} strokeWidth={1.5} />
        </button>

        {def.fields.length > 0 && (
          <button
            className="w-5 h-5 rounded flex items-center justify-center text-fg-subtle hover:text-fg hover:bg-bg-hover"
            title="Expand"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onExpand();
            }}
          >
            <Maximize2 size={11} strokeWidth={1.5} />
          </button>
        )}

        <button
          className="w-5 h-5 rounded flex items-center justify-center text-fg-subtle hover:text-red-500 hover:bg-red-500/10"
          title="Delete (Del)"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
        >
          <X size={11} strokeWidth={1.5} />
        </button>
      </div>

      {/* Ports */}
      {def.inputs.map((p, i) => (
        <Port
          key={`in-${p.name}`}
          side="in"
          name={p.name}
          kind={p.type}
          label={p.label}
          y={NODE_HEADER_HEIGHT + 14 + i * NODE_PORT_SPACING}
          onUp={(e) => onInputPortUp(p.name, e)}
        />
      ))}
      {def.outputs.map((p, i) => (
        <Port
          key={`out-${p.name}`}
          side="out"
          name={p.name}
          kind={p.type}
          label={p.label}
          y={NODE_HEADER_HEIGHT + 14 + i * NODE_PORT_SPACING}
          onDown={(e) => onOutputPortDown(p.name, e)}
        />
      ))}

      {/* Body */}
      <div className="p-3 text-[12px]">
        {/* Description (only when empty) */}
        {!hasContent(node) && def.description && (
          <p className="text-fg-muted leading-snug mb-2">{def.description}</p>
        )}

        {/* Examples & starters chips (only when empty) */}
        {!hasContent(node) && def.examples && def.examples.length > 0 && (
          <div className="mb-2">
            <div className="text-[9px] uppercase tracking-wider text-fg-subtle mb-1 font-medium">Try an example</div>
            <div className="flex flex-wrap gap-1">
              {def.examples.map((ex) => (
                <button
                  key={ex}
                  className="px-2 py-0.5 rounded-full text-[10px] bg-bg-subtle border border-border hover:border-border-strong text-fg-muted hover:text-fg"
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (def.primaryField) onConfigChange(def.primaryField, ex);
                  }}
                >
                  {ex}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Custom upload zone */}
        {def.custom === "upload-image" && (
          <UploadZone
            kind="image"
            currentUrl={(node.config.cdnUrl as string) || (node.config.dataUrl as string) || ""}
            onUpload={async (file) => {
              const r = await onUploadFile(file);
              onConfigChange("cdnUrl", r.cdnUrl);
              onConfigChange("dataUrl", r.cdnUrl);
              onConfigChange("filename", file.name);
            }}
            onClear={() => {
              onConfigChange("cdnUrl", "");
              onConfigChange("dataUrl", "");
            }}
          />
        )}
        {def.custom === "upload-video" && (
          <UploadZone
            kind="video"
            currentUrl={(node.config.cdnUrl as string) || (node.config.url as string) || ""}
            onUpload={async (file) => {
              const r = await onUploadFile(file);
              onConfigChange("cdnUrl", r.cdnUrl);
              onConfigChange("url", r.cdnUrl);
            }}
            onClear={() => {
              onConfigChange("cdnUrl", "");
              onConfigChange("url", "");
            }}
            onUrl={(url) => onConfigChange("url", url)}
          />
        )}
        {def.custom === "upload-audio" && (
          <UploadZone
            kind="audio"
            currentUrl={(node.config.cdnUrl as string) || (node.config.url as string) || ""}
            onUpload={async (file) => {
              const r = await onUploadFile(file);
              onConfigChange("cdnUrl", r.cdnUrl);
              onConfigChange("url", r.cdnUrl);
            }}
            onClear={() => {
              onConfigChange("cdnUrl", "");
              onConfigChange("url", "");
            }}
            onUrl={(url) => onConfigChange("url", url)}
          />
        )}

        {/* Note custom */}
        {def.custom === "note" && (
          <textarea
            className="w-full bg-transparent border-none outline-none text-fg text-[12px] resize-none"
            placeholder="Type a note…"
            rows={4}
            value={(node.config.text as string) ?? ""}
            onChange={(e) => onConfigChange("text", e.target.value)}
            onMouseDown={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          />
        )}

        {/* Output preview */}
        {status === "done" && node.outputs && Object.keys(node.outputs).length > 0 && (
          <OutputPreview
            outputs={node.outputs}
            results={node.results}
            selectedIdx={selectedResultIdx}
            onSelectIdx={setSelectedResultIdx}
          />
        )}

        {/* Running state */}
        {status === "running" && (
          <div className="my-2 flex items-center gap-2 px-2.5 py-2 rounded-md bg-amber-500/10 border border-amber-500/30 text-amber-600 dark:text-amber-400 text-[11px]">
            <span className="spinner text-amber-500" />
            <span>Generating…</span>
          </div>
        )}

        {/* Error state */}
        {status === "error" && node.error && (
          <div className="my-2 flex items-start gap-2 px-2.5 py-2 rounded-md bg-red-500/10 border border-red-500/30 text-red-600 dark:text-red-400 text-[11px] leading-snug">
            <AlertCircle size={12} strokeWidth={1.5} className="shrink-0 mt-0.5" />
            <span>{node.error}</span>
          </div>
        )}

        {/* Primary instructions textarea */}
        {def.primaryField && !def.custom && (
          <div className="rounded-md bg-bg-subtle border border-border p-2 mt-1">
            <label className="block text-[9px] uppercase tracking-wider text-fg-subtle font-medium mb-1">
              {def.primaryLabel ?? "Instructions"}
            </label>
            <textarea
              className="w-full bg-transparent border-none outline-none text-fg text-[12px] resize-none min-h-[40px] max-h-[100px] leading-snug"
              placeholder={def.primaryPlaceholder ?? "Write text…"}
              value={(node.config[def.primaryField] as string) ?? ""}
              onChange={(e) => onConfigChange(def.primaryField!, e.target.value)}
              onMouseDown={(e) => e.stopPropagation()}
              onPointerDown={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
            />
          </div>
        )}

        {/* Quick controls + Run button */}
        {(def.fields.length > 0 || def.outputs.length > 0) && !def.custom && (
          <div className="flex items-center gap-1.5 mt-2 flex-wrap">
            {(def.quickFields ?? []).map((fname) => {
              const f = def.fields.find((x) => x.name === fname);
              if (!f) return null;
              return <QuickField key={fname} field={f} value={node.config[fname]} onChange={(v) => onConfigChange(fname, v)} />;
            })}
            <div className="flex-1" />
            {def.outputs.length > 0 && status === "running" && (
              <button
                className="w-7 h-7 rounded-full bg-red-500 text-white flex items-center justify-center hover:bg-red-600"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  onStop?.();
                }}
                title="Stop this run"
              >
                <div className="w-2.5 h-2.5 bg-white rounded-sm" />
              </button>
            )}
            {def.outputs.length > 0 && status !== "running" && (
              <button
                className="w-7 h-7 rounded-full bg-fg text-bg flex items-center justify-center hover:opacity-80"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  onRun();
                }}
                title="Run this node"
              >
                <Play size={11} strokeWidth={2} fill="currentColor" />
              </button>
            )}
          </div>
        )}
      </div>
    </div>
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

/**
 * Memoised wrapper — only re-renders when the node's *content* actually changes.
 * Critical for drag perf: dragging one node should not re-render every other node.
 * Callbacks are ignored in equality (they are inline-recreated in Canvas but identical-behaviour).
 */
const CanvasNode = memo(CanvasNodeImpl, (prev, next) => {
  if (prev.isSelected !== next.isSelected) return false;
  if (prev.isRunning !== next.isRunning) return false;
  const a = prev.node;
  const b = next.node;
  if (a.id !== b.id) return false;
  if (a.position.x !== b.position.x || a.position.y !== b.position.y) return false;
  if (a.status !== b.status) return false;
  if (a.error !== b.error) return false;
  if (a.config !== b.config) return false;
  if (a.outputs !== b.outputs) return false;
  if (a.results !== b.results) return false;
  return true;
});

export default CanvasNode;

function StatusDot({ status }: { status: "idle" | "pending" | "running" | "done" | "error" }) {
  const cls =
    status === "running" || status === "pending"
      ? "bg-amber-400 animate-pulse"
      : status === "done"
      ? "bg-emerald-400"
      : status === "error"
      ? "bg-red-500"
      : "bg-fg-subtle/30";
  return <span className={`w-1.5 h-1.5 rounded-full ${cls}`} />;
}

function hasContent(node: GraphNode): boolean {
  const def = NODE_TYPES[node.type];
  if (!def?.primaryField) return false;
  return Boolean((node.config[def.primaryField] as string)?.trim());
}

function Port({
  side, name, kind, label, y, onDown, onUp,
}: {
  side: "in" | "out";
  name: string;
  kind: string;
  label?: string;
  y: number;
  onDown?: (e: React.PointerEvent) => void;
  onUp?: (e: React.PointerEvent) => void;
}) {
  const color = PORT_COLORS[kind] ?? "#71717a";
  return (
    <div
      className="absolute group/port"
      style={{
        top: y,
        [side === "in" ? "left" : "right"]: -7,
      }}
    >
      <button
        className="w-3.5 h-3.5 rounded-full bg-bg-card border-2 cursor-crosshair hover:scale-125 transition-transform"
        style={{ borderColor: color }}
        data-port-side={side}
        data-port-kind={kind}
        data-port-id={name}
        onPointerDown={(e) => {
          if (side === "out") {
            e.stopPropagation();
            onDown?.(e);
          }
        }}
        onPointerUp={(e) => {
          if (side === "in") {
            e.stopPropagation();
            onUp?.(e);
          }
        }}
        title={`${label ?? name} · ${kind}`}
      />
      <div
        className={`absolute top-1/2 -translate-y-1/2 opacity-0 group-hover/port:opacity-100 pointer-events-none whitespace-nowrap text-[10px] px-1.5 py-0.5 rounded bg-fg text-bg ${
          side === "in" ? "left-5" : "right-5"
        }`}
      >
        {label ?? name}
      </div>
    </div>
  );
}

const PORT_COLORS: Record<string, string> = {
  text: "#3b82f6",
  image: "#10b981",
  video: "#ec4899",
  audio: "#f97316",
  any: "#facc15",
};

function QuickField({
  field,
  value,
  onChange,
}: {
  field: FieldDef;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  if (field.type !== "select") return null;
  return (
    <div
      className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-border bg-bg-subtle hover:border-border-strong text-fg-muted text-[10px]"
      onMouseDown={(e) => e.stopPropagation()}
    >
      <select
        title={field.label}
        className="appearance-none bg-transparent border-none outline-none text-fg text-[10px] cursor-pointer pr-1 max-w-[100px] truncate"
        value={String(value ?? "")}
        onChange={(e) => onChange(e.target.value)}
      >
        {field.options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
      <ChevronDown size={9} strokeWidth={1.5} />
    </div>
  );
}

function OutputPreview({
  outputs,
  results,
  selectedIdx,
  onSelectIdx,
}: {
  outputs: Record<string, unknown>;
  results?: { value: string; mime?: string }[];
  selectedIdx: number;
  onSelectIdx: (i: number) => void;
}) {
  const list = results && results.length > 0 ? results : Object.values(outputs).filter((v) => typeof v === "string").map((v) => ({ value: v as string }));
  if (list.length === 0) return null;
  const current = list[Math.min(selectedIdx, list.length - 1)];
  const url = current.value;

  return (
    <div className="mb-2">
      <PreviewMedia url={url} />
      {list.length > 1 && (
        <div className="mt-1 flex gap-1 overflow-x-auto">
          {list.map((r, i) => (
            <button
              key={i}
              onClick={(e) => {
                e.stopPropagation();
                onSelectIdx(i);
              }}
              onMouseDown={(e) => e.stopPropagation()}
              className={`shrink-0 w-10 h-10 rounded overflow-hidden border-2 ${
                i === selectedIdx ? "border-brand" : "border-transparent hover:border-border-strong"
              }`}
            >
              <PreviewThumb url={r.value} />
            </button>
          ))}
        </div>
      )}
      {list.length > 1 && (
        <div className="text-[9px] text-fg-subtle text-center mt-0.5">
          {selectedIdx + 1} of {list.length}
        </div>
      )}
    </div>
  );
}

function PreviewMedia({ url }: { url: string }) {
  if (!url) return null;
  if (isVideo(url)) {
    return <video src={url} controls muted className="w-full max-h-40 rounded-md bg-black" />;
  }
  if (isAudio(url)) {
    return <audio src={url} controls className="w-full" />;
  }
  if (isImage(url) || url.startsWith("data:image")) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={url} alt="" className="w-full max-h-40 rounded-md object-cover bg-bg-subtle" />
    );
  }
  // text
  return (
    <div className="rounded-md bg-bg-subtle border border-border p-2 max-h-28 overflow-auto text-[11px] font-mono whitespace-pre-wrap break-words text-fg">
      {url.length > 500 ? url.slice(0, 500) + "…" : url}
    </div>
  );
}

function PreviewThumb({ url }: { url: string }) {
  if (isImage(url)) return <img src={url} alt="" className="w-full h-full object-cover" />;
  if (isVideo(url)) return <video src={url} className="w-full h-full object-cover" muted />;
  return <div className="w-full h-full bg-bg-hover" />;
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
