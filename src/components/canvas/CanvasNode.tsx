"use client";

import { useState, useEffect, useRef, memo } from "react";
import { ChevronDown, ChevronUp, Info, MoreHorizontal, Play, Maximize2, X, AlertCircle, Expand, Move } from "lucide-react";
import { WheelScroll } from "./WheelScroll";
import VideoGenControls from "./VideoGenControls";
import Lightbox from "./Lightbox";
import TrackEditor, { type TrackKey } from "./TrackEditor";
import { NODE_TYPES, getActiveInputs, type GraphNode, type GraphEdge, type FieldDef } from "@/lib/canvas/types";
import { NodeIcon } from "@/lib/canvas/icons";
import UploadZone from "./UploadZone";
import BrandAssetsPicker from "./BrandAssetsPicker";
import SaveToLibraryButton from "@/components/SaveToLibraryButton";

export const NODE_WIDTH = 280;
// h-9 (36px) + border-b-1 = 37, but visually centre matches 36 better
export const NODE_HEADER_HEIGHT = 36;
export const NODE_PORT_SPACING = 26;

export function getNodeHeight(node: GraphNode): number {
  // Rough — actual height is determined by content. We use 200 as a baseline for edge routing.
  // Real heights come from DOM measurement during render.
  return 240;
}

export function portYOffset(node: GraphNode, portId: string, side: "in" | "out"): number {
  const def = NODE_TYPES[node.type];
  if (!def) return NODE_HEADER_HEIGHT;
  // For input side we use the ACTIVE-only list so port Y positions match
  // exactly what the user sees on the node. If we used `def.inputs` here
  // (which contains inactive/legacy ports too), edges to the visible
  // ports would land in the wrong vertical slots.
  const list = side === "in" ? getActiveInputs(def, node.config) : def.outputs;
  const idx = list.findIndex((p) => p.name === portId);
  if (idx < 0) return NODE_HEADER_HEIGHT;
  return NODE_HEADER_HEIGHT + 14 + idx * NODE_PORT_SPACING;
}

function CanvasNodeImpl({
  node,
  edges,
  resolvedInputs,
  sourceVideoUrl,
  cachedTrackUrl,
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
  composerTracks,
  videoRefs,
  editorHref,
  onStashTracks,
}: {
  node: GraphNode;
  edges: GraphEdge[];
  /** Map of input-port-name → text value resolved from upstream nodes' outputs.
   * Used to show what context/prompt will be passed into this node at run-time,
   * so users can see live previews of upstream-generated prompts in the input
   * field before clicking Run. Image/video URLs are NOT included here. */
  resolvedInputs: Record<string, string>;
  sourceVideoUrl?: string;
  cachedTrackUrl?: string;
  isSelected: boolean;
  isRunning: boolean;
  onPointerDown: (e: React.PointerEvent) => void;
  onOutputPortDown: (portId: string, e: React.PointerEvent) => void;
  onInputPortUp: (portId: string, e: React.PointerEvent) => void;
  onSelect: (additive?: boolean) => void;
  onDelete: () => void;
  onConfigChange: (key: string, value: unknown) => void;
  onRun: () => void;
  onStop?: () => void;
  onExpand: () => void;
  onUploadFile: (file: File, onProgress?: (pct: number) => void) => Promise<{ cdnUrl: string }>;
  workflowMeta: { brandId: string | null; brandSlug?: string | null; projectId: string; workflowId: string };
  /** Composer node only: ordered upstream tracks resolved by Canvas */
  composerTracks?: { kind: string; value: string; label: string; section?: string }[];
  /** videoGen only: connected reference inputs (images/videos) with thumbnails,
   *  in edge order, so the node can show numbered click-to-insert chips. */
  videoRefs?: { port: string; kind: "image" | "video"; url: string }[];
  /** Composer node only: href of this workflow's editor */
  editorHref?: string;
  /** Composer node only: stash the connected tracks right before navigation */
  onStashTracks?: () => void;
}) {
  const composerDownRef = useRef<{ x: number; y: number } | null>(null);
  const [tracksSent, setTracksSent] = useState(false);
  // HeyGen node: account avatars/voices
  const isHeygen = NODE_TYPES[node.type]?.custom === "heygen";
  const [hg, setHg] = useState<{ avatars: HgAvatar[]; voices: HgVoice[] } | null>(hgCache);
  const [hgErr, setHgErr] = useState<string | null>(null);
  const [hgAvQ, setHgAvQ] = useState("");
  const [hgVoQ, setHgVoQ] = useState("");
  const [hgCap, setHgCap] = useState(60);
  useEffect(() => { setHgCap(60); }, [hgAvQ]);
  const hgAudioRef = useRef<HTMLAudioElement | null>(null);
  const [hgPlaying, setHgPlaying] = useState(false);
  useEffect(() => {
    if (!isHeygen || hg) return;
    let alive = true;
    loadHeygenOptions().then((d) => { if (alive) setHg(d); }).catch((e) => { if (alive) setHgErr(e instanceof Error ? e.message : "load failed"); });
    return () => { alive = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isHeygen]);
  useEffect(() => () => { hgAudioRef.current?.pause(); }, []);
  const def = NODE_TYPES[node.type];
  if (!def) return null;

  const status = node.status ?? "idle";
  const color = node.type ? CAT_COLORS[def.category] : "#71717a";
  const [selectedResultIdx, setSelectedResultIdx] = useState(0);
  // Inline-expand: a middle size between compact (default) and the full
  // modal. Toggled by the chevron in the header. Only grows the node's
  // CONTENT height (bigger textarea, bigger preview) — width stays
  // NODE_WIDTH so output-port X positions (computed from NODE_WIDTH in
  // CanvasEdges) don't drift and edges keep landing correctly.
  const [inlineExpanded, setInlineExpanded] = useState(false);
  // Info popover (the "i" button) — shows what the node does + its ports.
  const [showInfo, setShowInfo] = useState(false);
  const infoRef = useRef<HTMLDivElement>(null);
  // Close the info popover on click outside or Esc.
  useEffect(() => {
    if (!showInfo) return;
    function onDown(e: MouseEvent) {
      if (!infoRef.current?.contains(e.target as Node)) setShowInfo(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setShowInfo(false);
    }
    const t = setTimeout(() => document.addEventListener("mousedown", onDown), 50);
    document.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(t);
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [showInfo]);
  // Lightbox state — when set, renders fullscreen viewer for image/video.
  // `list` and `idx` enable ←/→ navigation through a multi-result carousel.
  const [lightbox, setLightbox] = useState<{
    src: string;
    kind: "image" | "video";
    list?: string[];
    idx?: number;
  } | null>(null);
  // Screen Replace: interactive track-corrector modal open state.
  const [trackOpen, setTrackOpen] = useState(false);
  const parseTrackKeys = (s: unknown): TrackKey[] => {
    if (typeof s !== "string" || !s.trim()) return [];
    try { const a = JSON.parse(s); return Array.isArray(a) ? a : []; } catch { return []; }
  };
  // Pre-filter edges incoming to this node — used to count refs on multi-ports.
  const edgesTo = edges.filter((e) => e.to.nodeId === node.id);

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
        width: NODE_TYPES[node.type]?.custom === "heygen" && inlineExpanded ? NODE_WIDTH * 2 : NODE_WIDTH,
        transform: `translate(${node.position.x}px, ${node.position.y}px)`,
        willChange: "transform",
      }}
      onClick={(e) => {
        e.stopPropagation();
        onSelect(e.shiftKey || e.metaKey || e.ctrlKey);
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
          className="w-5 h-5 rounded flex items-center justify-center text-fg-subtle hover:text-fg hover:bg-bg-hover relative"
          title="About this node"
          onMouseDown={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            setShowInfo((v) => !v);
          }}
        >
          <Info size={11} strokeWidth={1.5} />
        </button>
        {showInfo && (
          <div
            ref={infoRef}
            className="absolute top-9 right-2 z-30 w-60 rounded-lg bg-bg-card border border-border shadow-panel p-3 text-left nodrag"
            onMouseDown={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-1">
              <span className="text-[12px] font-semibold text-fg">{def.name}</span>
              <button
                className="text-fg-subtle hover:text-fg"
                onClick={(e) => { e.stopPropagation(); setShowInfo(false); }}
              >
                <X size={12} />
              </button>
            </div>
            {def.description && (
              <p className="text-[11px] text-fg-muted leading-snug mb-2">{def.description}</p>
            )}
            {(() => {
              const ins = getActiveInputs(def, node.config);
              return (
                <div className="space-y-1.5">
                  {ins.length > 0 && (
                    <div>
                      <div className="text-[9px] uppercase tracking-wider text-fg-subtle font-medium">Inputs</div>
                      <div className="text-[10px] text-fg-muted">
                        {ins.map((p) => p.label ?? p.name).join(", ")}
                      </div>
                    </div>
                  )}
                  {def.outputs.length > 0 && (
                    <div>
                      <div className="text-[9px] uppercase tracking-wider text-fg-subtle font-medium">Outputs</div>
                      <div className="text-[10px] text-fg-muted">
                        {def.outputs.map((p) => p.label ?? p.name).join(", ")}
                      </div>
                    </div>
                  )}
                  <div className="text-[10px] text-fg-subtle pt-1 border-t border-border">
                    Drag a port to connect · ⤢ to expand · ▶ to run
                  </div>
                </div>
              );
            })()}
          </div>
        )}

        {/* Inline-expand toggle — middle size between compact and modal.
            Grows the textarea + preview in place without opening the
            fullscreen modal. Chevron flips to indicate state. */}
        <button
          className="w-5 h-5 rounded flex items-center justify-center text-fg-subtle hover:text-fg hover:bg-bg-hover"
          title={inlineExpanded ? "Collapse" : "Expand inline"}
          onMouseDown={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            setInlineExpanded((v) => !v);
          }}
        >
          {inlineExpanded ? (
            <ChevronUp size={12} strokeWidth={1.5} />
          ) : (
            <ChevronDown size={12} strokeWidth={1.5} />
          )}
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

      {/* Ports — only the ones active for current config (mode-gated etc) */}
      {getActiveInputs(def, node.config).map((p, i) => (
        <Port
          key={`in-${p.name}`}
          side="in"
          name={p.name}
          kind={p.type}
          label={p.label}
          multi={p.multi}
          // Show a small count badge on multi-ports so the user sees at a
          // glance how many references are connected without zooming in.
          edgeCount={
            p.multi
              ? edgesTo.filter((e) => e.to.port === p.name).length
              : 0
          }
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
            onUpload={async (file, onProgress) => {
              const r = await onUploadFile(file, onProgress);
              onConfigChange("cdnUrl", r.cdnUrl);
              onConfigChange("dataUrl", r.cdnUrl);
              onConfigChange("filename", file.name);
            }}
            onClear={() => {
              onConfigChange("cdnUrl", "");
              onConfigChange("dataUrl", "");
            }}
            onExpand={() => {
              const url =
                (node.config.cdnUrl as string) ||
                (node.config.dataUrl as string) ||
                "";
              if (url) setLightbox({ src: url, kind: "image" });
            }}
          />
        )}
        {def.custom === "upload-video" && (
          <UploadZone
            kind="video"
            currentUrl={(node.config.cdnUrl as string) || (node.config.url as string) || ""}
            onUpload={async (file, onProgress) => {
              const r = await onUploadFile(file, onProgress);
              onConfigChange("cdnUrl", r.cdnUrl);
              onConfigChange("url", r.cdnUrl);
            }}
            onClear={() => {
              onConfigChange("cdnUrl", "");
              onConfigChange("url", "");
            }}
            onUrl={(url) => onConfigChange("url", url)}
            onExpand={() => {
              const url =
                (node.config.cdnUrl as string) ||
                (node.config.url as string) ||
                "";
              if (url) setLightbox({ src: url, kind: "video" });
            }}
          />
        )}
        {def.custom === "upload-audio" && (
          <UploadZone
            kind="audio"
            currentUrl={(node.config.cdnUrl as string) || (node.config.url as string) || ""}
            onUpload={async (file, onProgress) => {
              const r = await onUploadFile(file, onProgress);
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

        {/* Brand Assets — grid of brand's UI screenshots with checkboxes. */}
        {def.custom === "brand-assets" && (
          <BrandAssetsPicker
            brandId={workflowMeta.brandId}
            brandSlug={workflowMeta.brandSlug ?? null}
            expanded={inlineExpanded}
            selected={
              Array.isArray(node.config.selected)
                ? (node.config.selected as string[])
                : []
            }
            onChange={(next) => onConfigChange("selected", next)}
          />
        )}

        {/* Note custom */}
        {def.custom === "heygen" && (
          <div className="space-y-1.5 text-[11px]" onPointerDown={(e) => e.stopPropagation()}>
            {hgErr && <div className="text-red-400 text-[10px]">{hgErr}</div>}
            {!hg && !hgErr && <div className="text-fg-subtle text-[10px]">Loading avatars & voices…</div>}
            {hg && (() => {
              const av = String(node.config?.avatar_id ?? "");
              const vo = String(node.config?.voice_id ?? "");
              const avSel = hg.avatars.find((a) => a.id === av) || null;
              const voSel = hg.voices.find((v) => v.id === vo) || null;
              const hasImageInput = edgesTo.some((e) => e.to.port === "image");
              const avFiltered = hgAvQ ? hg.avatars.filter((a) => a.name.toLowerCase().includes(hgAvQ.toLowerCase())) : hg.avatars;
              const avList = avFiltered.slice(0, hgCap);
              const voList = (hgVoQ ? hg.voices.filter((v) => `${v.name} ${v.language ?? ""}`.toLowerCase().includes(hgVoQ.toLowerCase())) : hg.voices).slice(0, 200);
              const needVoice = (av || hasImageInput);
              return (
                <>
                  {hasImageInput && (
                    <div className="rounded-md border border-brand/40 bg-brand/5 px-2 py-1.5 text-[10px] text-fg">
                      <b>Custom avatar (Avatar IV)</b> — the connected image speaks via HeyGen Avatar IV. Pick a voice below; aspect (9:16 / 16:9) follows the Dimension setting, and the Background colour is supported (e.g. green for chroma key). Runs on your HeyGen <b>credits</b> — no photo-avatar slot, no 3-avatar limit. Pick the picture model on the connected Image Generation node.
                    </div>
                  )}
                  {!hasImageInput && (
                    <>
                      <div className="flex items-center justify-between gap-2">
                        <input value={hgAvQ} onChange={(e) => setHgAvQ(e.target.value)} placeholder={`Search ${hg.avatars.length} avatars…`}
                          onPointerDown={(e) => e.stopPropagation()}
                          className="flex-1 bg-bg border border-border rounded px-1.5 py-1 text-[10px] outline-none" />
                        {av && <button type="button" onClick={() => onConfigChange("avatar_id", "")} className="text-[9px] text-fg-subtle hover:text-fg whitespace-nowrap">clear</button>}
                      </div>
                      <WheelScroll
                        className={`grid gap-1 overflow-y-auto ${inlineExpanded ? "grid-cols-5 max-h-[60vh]" : "grid-cols-3 max-h-36"}`}
                        onScroll={(e) => {
                          const el = e.currentTarget;
                          if (el.scrollTop + el.clientHeight >= el.scrollHeight - 240) setHgCap((c) => (c < avFiltered.length ? c + 60 : c));
                        }}>
                        {/* prompt-agent tile */}
                        <button type="button" onClick={() => onConfigChange("avatar_id", "")}
                          className={`relative rounded-md border aspect-[3/4] grid place-items-center text-[8px] text-center leading-tight p-1 ${av === "" ? "border-brand ring-1 ring-brand text-brand" : "border-dashed border-border text-fg-subtle hover:border-brand/50"}`}>
                          Prompt agent (auto)
                        </button>
                        {avList.map((a) => (
                          <button key={a.id} type="button" onClick={() => onConfigChange("avatar_id", a.id)}
                            title={a.name}
                            className={`relative rounded-md overflow-hidden border aspect-[3/4] ${av === a.id ? "border-brand ring-1 ring-brand" : "border-border hover:border-brand/50"}`}>
                            {a.preview ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img src={a.preview} alt="" loading="lazy" className="w-full h-full object-cover" />
                            ) : (
                              <div className="w-full h-full grid place-items-center text-[7px] text-fg-subtle p-0.5 text-center">{a.name}</div>
                            )}
                            <span className="absolute inset-x-0 bottom-0 bg-black/60 text-white text-[7px] px-0.5 py-px truncate">{a.name}</span>
                          </button>
                        ))}
                      </WheelScroll>
                      <div className="flex items-center justify-between text-[9px] text-fg-subtle">
                        <span>{avList.length < avFiltered.length ? `Showing ${avList.length} of ${avFiltered.length} — scroll for more` : `${avFiltered.length} avatar${avFiltered.length === 1 ? "" : "s"}`}</span>
                        {!inlineExpanded && <span>⤢ to enlarge</span>}
                      </div>
                    </>
                  )}
                  {/* Voice */}
                  <div className="flex items-center gap-2 pt-0.5">
                    <button type="button" disabled={!voSel?.preview}
                      onClick={() => {
                        const cur = hgAudioRef.current;
                        if (hgPlaying && cur) { cur.pause(); setHgPlaying(false); return; }
                        if (!voSel?.preview) return;
                        if (cur) cur.pause();
                        const a = new Audio(voSel.preview); a.volume = 0.9; a.onended = () => setHgPlaying(false);
                        hgAudioRef.current = a; setHgPlaying(true); a.play().catch(() => setHgPlaying(false));
                      }}
                      className="w-9 h-9 rounded-md border border-border grid place-items-center text-fg-muted hover:text-fg disabled:opacity-30 shrink-0">
                      {hgPlaying ? "⏸" : "▶"}
                    </button>
                    <div className="flex-1 min-w-0 space-y-1">
                      <input value={hgVoQ} onChange={(e) => setHgVoQ(e.target.value)} placeholder={`Search ${hg.voices.length} voices…`}
                        className="w-full bg-bg border border-border rounded px-1.5 py-1 text-[10px] outline-none" />
                      <select value={vo} onChange={(e) => onConfigChange("voice_id", e.target.value)}
                        className="w-full bg-bg border border-border rounded px-1 py-1 text-[10px] outline-none">
                        <option value="">{needVoice ? "— pick a voice —" : "— no voice (prompt agent) —"}</option>
                        {voSel && !voList.includes(voSel) && <option value={voSel.id}>{voSel.name}{voSel.language ? ` · ${voSel.language}` : ""}</option>}
                        {voList.map((v) => <option key={v.id} value={v.id}>{v.name}{v.language ? ` · ${v.language}` : ""}</option>)}
                      </select>
                    </div>
                  </div>
                  {/* Engine picker — library avatars only; custom-avatar (image)
                      always uses Avatar IV on credits, so no picker there. */}
                  {(needVoice && vo && !hasImageInput) && (
                    <label className="flex items-center justify-between gap-2 text-[10px] text-fg-muted">
                      <span>Engine</span>
                      <select value={String(node.config?.engine ?? "")} onChange={(e) => onConfigChange("engine", e.target.value)}
                        className="flex-1 bg-bg border border-border rounded px-1 py-1 text-[10px] outline-none">
                        <option value="">Avatar III — fast / cheap</option>
                        <option value="av4">Avatar IV — expressive</option>
                      </select>
                    </label>
                  )}
                  {/* Output settings — shown once we're in full mode */}
                  {(needVoice && vo) && (
                    <div className="space-y-1.5">
                      <div className="grid grid-cols-2 gap-1.5">
                        {!hasImageInput && (
                          <select value={String(node.config?.avatar_style ?? "normal")} onChange={(e) => onConfigChange("avatar_style", e.target.value)}
                            className="bg-bg border border-border rounded px-1 py-1 text-[10px] outline-none">
                            <option value="normal">Full body</option><option value="circle">Circle</option><option value="closeUp">Close-up</option>
                          </select>
                        )}
                        <select value={String(node.config?.dimension ?? "720x1280")} onChange={(e) => onConfigChange("dimension", e.target.value)}
                          className="bg-bg border border-border rounded px-1 py-1 text-[10px] outline-none">
                          <option value="720x1280">720×1280 (9:16)</option><option value="1080x1920">1080×1920 (9:16)</option>
                          <option value="1280x720">1280×720 (16:9)</option><option value="1920x1080">1920×1080 (16:9)</option>
                          <option value="1080x1080">1080×1080 (1:1)</option>
                        </select>
                        <label className="flex items-center gap-1 text-[10px] text-fg-muted">Speed
                          <input type="number" min={0.5} max={1.5} step={0.05} value={Number(node.config?.speed ?? 1)} onChange={(e) => onConfigChange("speed", Number(e.target.value) || 1)}
                            className="w-full bg-bg border border-border rounded px-1 py-1 text-[10px] outline-none" />
                        </label>
                      </div>
                      <div className="flex items-center gap-2 text-[10px] text-fg-muted">
                        <label className="flex items-center gap-1">
                          <input type="checkbox" checked={Boolean(node.config?.bgEnabled)} onChange={(e) => onConfigChange("bgEnabled", e.target.checked)} />
                          Background
                        </label>
                        {Boolean(node.config?.bgEnabled) && (
                          <>
                            <input type="color" value={String(node.config?.bgColor ?? "#00FF00")} onChange={(e) => onConfigChange("bgColor", e.target.value)}
                              className="w-7 h-6 rounded border border-border bg-transparent cursor-pointer p-0" />
                            <button type="button" onClick={() => onConfigChange("bgColor", "#00FF00")} className="px-1.5 py-0.5 rounded border border-border hover:border-brand text-[9px]">Green screen</button>
                            <span className="text-fg-subtle">{String(node.config?.bgColor ?? "#00FF00")}</span>
                          </>
                        )}
                      </div>
                      {Boolean(node.config?.bgEnabled) && <div className="text-[9px] text-fg-subtle">Tip: green background → drop into the editor → chroma key it out to place the avatar over any footage.</div>}
                    </div>
                  )}
                  <div className="text-[9px] text-fg-subtle leading-tight">
                    {hasImageInput ? "Script is spoken by the connected image (talking photo)." : (av && vo) ? "Script is spoken verbatim by the chosen avatar/voice." : "Nothing picked — HeyGen's prompt agent decides everything from the prompt."}
                  </div>
                </>
              );
            })()}
          </div>
        )}
        {def.custom === "composer" && (
          <div className="space-y-1.5 text-[11px]" onPointerDown={(e) => e.stopPropagation()}>
            {(composerTracks?.length ?? 0) === 0 && (
              <div className="text-fg-subtle">Connect image / video / audio / text outputs to the <b>Tracks</b> port — each becomes a timeline layer (top to bottom by node position).</div>
            )}
            {(composerTracks ?? []).slice(0, 8).map((t, i) => (
              <div key={i} className="flex items-center gap-1.5 text-fg-muted">
                <span className="w-4 text-right text-fg-subtle">{i + 1}.</span>
                <span className={`px-1 rounded text-[9px] uppercase ${t.kind === "video" ? "bg-sky-500/20 text-sky-300" : t.kind === "image" ? "bg-violet-500/20 text-violet-300" : t.kind === "audio" ? "bg-emerald-500/20 text-emerald-300" : "bg-amber-500/20 text-amber-300"}`}>{t.kind}</span>
                {t.section && <span className="px-1 rounded text-[9px] bg-purple-500/20 text-purple-300">{t.section}</span>}
                <span className="truncate flex-1" title={t.label}>{t.label}</span>
              </div>
            ))}
            {(composerTracks?.length ?? 0) > 8 && <div className="text-fg-subtle">…and {(composerTracks?.length ?? 0) - 8} more</div>}
            {(composerTracks?.length ?? 0) > 0 ? (
              <button type="button"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  if (onStashTracks) onStashTracks();
                  setTracksSent(true);
                  setTimeout(() => setTracksSent(false), 3000);
                }}
                className={`w-full inline-flex items-center justify-center gap-1.5 py-1.5 rounded-md text-[11px] font-medium ${tracksSent ? "bg-emerald-600 text-white" : "bg-brand text-white hover:opacity-90"}`}>
                {tracksSent ? "Sent ✓ — open the editor to see it" : `Send tracks to editor (${composerTracks!.length})`}
              </button>
            ) : (
              <span className="w-full inline-flex items-center justify-center gap-1.5 py-1.5 rounded-md bg-brand/40 text-white/60 text-[11px] font-medium cursor-not-allowed">
                Send tracks to editor
              </span>
            )}
            <a href={editorHref} target="_blank" rel="noreferrer" draggable={false}
              onPointerDown={(e) => { e.stopPropagation(); composerDownRef.current = { x: e.clientX, y: e.clientY }; }}
              onClick={(e) => {
                e.stopPropagation();
                const d = composerDownRef.current;
                if (d && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5) { e.preventDefault(); return; }
              }}
              className="w-full inline-flex items-center justify-center gap-1.5 py-1.5 rounded-md border border-border text-fg-muted hover:text-fg hover:border-brand text-[11px]">
              Open editor (keep current timeline)
            </a>
          </div>
        )}

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

        {/* Output preview — shown whenever the node has results, regardless
            of `status`. Status is volatile runtime state (lost on refresh),
            but outputs/results are persisted, so the condition keys off the
            actual data. When a node is re-running, outputs are cleared to
            `undefined` (see Canvas.tsx startRun), so this won't show stale
            content during a re-run. */}
        {/* For upload nodes (uploadImage/Video/Audio) the UploadZone above
            already renders the file with its own delete button. Rendering
            OutputPreview on top duplicates the same image with an Expand
            button — the cause of the "image doubled" UX bug. Skip it for
            those node types; the upload preview IS the output preview. */}
        {/* Screen Replace: open the interactive track corrector (drag → keyframes). */}
        {node.type === "screenReplace" && sourceVideoUrl && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setTrackOpen(true); }}
            className="nodrag w-full mb-1.5 inline-flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md border border-border text-fg-muted hover:text-fg hover:border-brand text-[11px]"
            title="Visually correct the screen track with keyframes"
          >
            <Move size={12} /> Adjust track
          </button>
        )}
        {((node.outputs && Object.keys(node.outputs).length > 0) ||
          (node.results && node.results.length > 0)) &&
          !def.custom?.startsWith("upload-") && (
          <OutputPreview
            outputs={node.outputs ?? {}}
            results={node.results}
            selectedIdx={selectedResultIdx}
            expanded={inlineExpanded}
            onSelectIdx={(i) => {
              setSelectedResultIdx(i);
              // Persist the selection so downstream nodes pick up the chosen
              // result (not always index 0). The executor's resolveInputs
              // reads node.config._selectedResultIdx and serves the matching
              // URL from node.results[idx] instead of node.outputs.<port>.
              onConfigChange("_selectedResultIdx", i);
            }}
            onExpand={(url) => {
              // Build the navigable list — prefer results[] when present,
              // otherwise just the single URL.
              const list =
                node.results && node.results.length > 0
                  ? node.results.map((r) => r.value)
                  : [url];
              const idx = Math.max(0, list.indexOf(url));
              setLightbox({
                src: url,
                kind: isVideo(url) ? "video" : "image",
                list,
                idx,
              });
            }}
          />
        )}

        {/* Save the current result into the brand library (auto-embeds).
            Shown for generative nodes (no def.custom) that have a result and a
            brand on the project. Reads the URL from results[] or, for a single
            result, from outputs.<port>. */}
        {(() => {
          if (def.custom || !workflowMeta.brandId) return null;
          const resultUrl =
            (node.results && node.results[selectedResultIdx]?.value) ||
            (node.results && node.results[0]?.value) ||
            (node.outputs
              ? (Object.values(node.outputs).find((v) => typeof v === "string" && (v as string).startsWith("http")) as string | undefined)
              : undefined) ||
            "";
          if (!resultUrl) return null;
          const promptLabel =
            (node.config.instructions as string) || (node.config.prompt as string) || undefined;
          return (
            <div className="mt-2 flex justify-end">
              <SaveToLibraryButton
                url={resultUrl}
                kind={isVideo(resultUrl) ? "video" : "image"}
                label={promptLabel}
                brandId={workflowMeta.brandId}
                compact
              />
            </div>
          );
        })()}

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

        {/* Upstream input preview — shows the resolved text values that will
            be passed into this node when Run is clicked. Renders compactly
            above the instructions box so the user can SEE that their TextGen
            output is wired through, even before running. Image/video URLs
            don't appear here — those flow visually via thumbnails. */}
        {Object.entries(resolvedInputs).map(([port, value]) => {
          if (!value || typeof value !== "string") return null;
          // Match the port to its definition to display a friendly label.
          const portDef = def.inputs.find((p) => p.name === port);
          if (!portDef || portDef.type !== "text") return null;
          return (
            <div
              key={`upstream-${port}`}
              className="rounded-md bg-brand/5 border border-brand/30 px-2 py-1.5 mt-1"
              title={value}
            >
              <div className="flex items-center justify-between mb-0.5">
                <span className="text-[8px] uppercase tracking-wider text-brand/80 font-medium">
                  ← {portDef.label ?? port}
                </span>
                <button
                  type="button"
                  className="text-[9px] text-fg-muted hover:text-fg"
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    void navigator.clipboard.writeText(value);
                  }}
                  title="Copy to clipboard"
                >
                  Copy
                </button>
              </div>
              <div className="text-fg text-[11px] leading-snug whitespace-pre-wrap break-words max-h-[80px] overflow-y-auto nodrag">
                {value}
              </div>
            </div>
          );
        })}

        {/* Primary instructions textarea OR multi-shot scene summary.
            For videoGen in multi-shot mode the instructions field has
            no meaning — each scene has its own prompt. We replace the
            textarea with a compact summary card that opens the scene
            builder in the expanded modal on click. */}
        {node.type === "videoGen" && node.config.mode === "multi-shot" ? (
          (() => {
            const scenes = (node.config.scenes as Array<{ prompt: string; duration: string }> | undefined) ?? [];
            const totalDur = scenes.reduce((sum, s) => sum + Number(s?.duration || 0), 0);
            const filled = scenes.filter((s) => s?.prompt?.trim()).length;
            return (
              <button
                type="button"
                onClick={onExpand}
                onMouseDown={(e) => e.stopPropagation()}
                onPointerDown={(e) => e.stopPropagation()}
                className="w-full rounded-md bg-bg-subtle border border-border hover:border-brand p-2 mt-1 text-left transition-colors"
              >
                <div className="text-[9px] uppercase tracking-wider text-fg-subtle font-medium mb-1">
                  Scene constructor
                </div>
                <div className="text-[12px] text-fg">
                  {scenes.length} scene{scenes.length !== 1 ? "s" : ""} · ~{totalDur}s
                  {filled < scenes.length && (
                    <span className="text-amber-600 ml-1">
                      ({scenes.length - filled} empty)
                    </span>
                  )}
                </div>
                <div className="text-[10px] text-fg-muted mt-0.5">Click to edit scenes</div>
              </button>
            );
          })()
        ) : (
          def.primaryField && !def.custom && (
            <div className="rounded-md bg-bg-subtle border border-border p-2 mt-1">
              <label className="block text-[9px] uppercase tracking-wider text-fg-subtle font-medium mb-1">
                {def.primaryLabel ?? "Instructions"}
              </label>
              <textarea
                className={`w-full bg-transparent border-none outline-none text-fg text-[12px] resize-none leading-snug nodrag ${
                  inlineExpanded ? "min-h-[200px] max-h-[400px]" : "min-h-[40px] max-h-[120px]"
                }`}
                placeholder={def.primaryPlaceholder ?? "Write text…"}
                value={(node.config[def.primaryField] as string) ?? ""}
                onChange={(e) => onConfigChange(def.primaryField!, e.target.value)}
                onMouseDown={(e) => e.stopPropagation()}
                onPointerDown={(e) => e.stopPropagation()}
                onKeyDown={(e) => e.stopPropagation()}
                // Auto-grow up to max-h (120px compact / 400px inline-expanded).
                // Past that point the textarea scrolls in place. For the FULL
                // editor users can still hit Maximize2 for the modal.
                ref={(el) => {
                  if (!el) return;
                  const cap = inlineExpanded ? 400 : 120;
                  el.style.height = "auto";
                  el.style.height = `${Math.min(cap, el.scrollHeight)}px`;
                }}
              />
            </div>
          )
        )}

        {/* Screen Replace: usage hint. */}
        {node.type === "screenReplace" && (
          <div className="mt-1 rounded-md border border-brand/40 bg-brand/5 px-2 py-1.5 text-[10px] text-fg leading-snug">
            Connect a <b>green-screen</b> video to <b>Source video</b> and an image or video to <b>Screen content</b>. Raise <b>Key strength</b> if the green is uneven.
          </div>
        )}

        {/* Video Generation: connected inputs as numbered chips. Tap an image
            or video chip to drop its reference token (@Image1 / [Video1]) into
            the prompt, so users don't have to guess which input is which. */}
        {node.type === "videoGen" && videoRefs && videoRefs.length > 0 && (() => {
          const seed = String(node.config.model || "").includes("seedance");
          let imgN = 0, vidN = 0;
          return (
            <div className="mt-1 rounded-md bg-bg-subtle border border-border p-2">
              <div className="text-[9px] uppercase tracking-wider text-fg-subtle font-medium mb-1.5">
                Connected inputs — tap to add to prompt
              </div>
              <div className="flex flex-wrap gap-1.5">
                {videoRefs.map((r, i) => {
                  let token: string | null = null;
                  let badge = "";
                  if (r.port === "references") { imgN++; token = seed ? `[Image${imgN}]` : `@Image${imgN}`; badge = token; }
                  else if (r.port === "reference_videos") { vidN++; token = seed ? `[Video${vidN}]` : `@Video${vidN}`; badge = token; }
                  else if (r.port === "source_video") badge = "Source";
                  else if (r.port === "start_frame") badge = "Start";
                  else if (r.port === "end_frame") badge = "End";
                  const clickable = token != null;
                  return (
                    <button
                      key={`${r.port}-${i}`}
                      type="button"
                      disabled={!clickable}
                      onMouseDown={(e) => e.stopPropagation()}
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={() => {
                        if (!token) return;
                        const cur = String(node.config.instructions || "").trim();
                        onConfigChange("instructions", `${cur} ${token}`.trim());
                      }}
                      title={clickable ? `Insert ${token} into the prompt` : badge}
                      className={`relative w-12 h-12 rounded overflow-hidden border bg-black/20 nodrag ${
                        clickable ? "border-border cursor-pointer hover:border-brand" : "border-border/60 opacity-70 cursor-default"
                      }`}
                    >
                      {r.kind === "video" ? (
                        <video src={r.url} muted playsInline preload="metadata" className="w-full h-full object-cover pointer-events-none" />
                      ) : (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={r.url} alt="" className="w-full h-full object-cover pointer-events-none" />
                      )}
                      <span className="absolute bottom-0 inset-x-0 bg-black/75 text-white text-[8px] font-medium text-center leading-tight py-[1px]">
                        {badge}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })()}

        {/* Video Generation: smart Mode → Model → Duration → Resolution. */}
        {node.type === "videoGen" && (
          <div className="mt-1">
            <VideoGenControls config={node.config} onConfigChange={onConfigChange} size="compact" />
          </div>
        )}

        {/* Quick controls + Run button. Custom-body nodes normally have no
            footer, but HeyGen is a real generative node and needs its Run. */}
        {(def.fields.length > 0 || def.outputs.length > 0) && (!def.custom || def.custom === "heygen") && (
          <div className="flex items-center gap-1.5 mt-2 flex-wrap">
            {(def.quickFields ?? []).map((fname) => {
              const f = def.fields.find((x) => x.name === fname);
              if (!f) return null;
              // Kling V3 i2v: aspect_ratio is ignored by the model (aspect
              // is inherited from start_image_url). We grey out the field
              // and explain why on hover instead of silently misleading.
              const modelStr = String(node.config.model ?? "");
              const isKlingV3I2V =
                modelStr.includes("kling-video/v3/") && modelStr.includes("image-to-video");
              const disabledReason =
                fname === "aspect" && isKlingV3I2V
                  ? "Kling V3 inherits aspect from the start image — this field is ignored."
                  : undefined;
              return (
                <QuickField
                  key={fname}
                  field={f}
                  value={node.config[fname]}
                  onChange={(v) => onConfigChange(fname, v)}
                  disabledReason={disabledReason}
                />
              );
            })}
            {(() => {
              const shown = (def.quickFields ?? []).filter((n) => def.fields.some((f) => f.name === n)).length;
              const more = def.fields.length - shown;
              if (more <= 0) return null;
              return (
                <button
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => { e.stopPropagation(); onExpand(); }}
                  className="inline-flex items-center px-2 py-1 rounded-md border border-dashed border-border text-[10px] text-fg-subtle hover:text-fg hover:border-border-strong"
                  title="Open Settings for all parameters"
                >
                  +{more} in Settings
                </button>
              );
            })()}
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

      {/* Fullscreen viewer for image/video results. Renders into a fixed-
          positioned div via Lightbox so it escapes the canvas transform. */}
      {lightbox && (
        <Lightbox
          src={lightbox.src}
          kind={lightbox.kind}
          onClose={() => setLightbox(null)}
          {...(lightbox.list && lightbox.list.length > 1 && lightbox.idx !== undefined
            ? {
                position: { current: lightbox.idx, total: lightbox.list.length },
                onPrev: () => {
                  const newIdx = (lightbox.idx! - 1 + lightbox.list!.length) % lightbox.list!.length;
                  const newSrc = lightbox.list![newIdx];
                  setLightbox({
                    ...lightbox,
                    src: newSrc,
                    idx: newIdx,
                    kind: isVideo(newSrc) ? "video" : "image",
                  });
                },
                onNext: () => {
                  const newIdx = (lightbox.idx! + 1) % lightbox.list!.length;
                  const newSrc = lightbox.list![newIdx];
                  setLightbox({
                    ...lightbox,
                    src: newSrc,
                    idx: newIdx,
                    kind: isVideo(newSrc) ? "video" : "image",
                  });
                },
              }
            : {})}
        />
      )}

      {/* Screen Replace: interactive track corrector. Renders fixed (escapes the
          canvas transform). Source = the connected source_video; saves keyframes
          back into config.track_keys, consumed by the compositor on the next run. */}
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

// HeyGen avatars/voices — fetched once per page, shared by every HeyGen node.
type HgAvatar = { id: string; name: string; preview: string | null };
type HgVoice = { id: string; name: string; language: string | null; preview: string | null };
let hgCache: { avatars: HgAvatar[]; voices: HgVoice[] } | null = null;
let hgPending: Promise<{ avatars: HgAvatar[]; voices: HgVoice[] }> | null = null;
async function loadHeygenOptions() {
  if (hgCache) return hgCache;
  if (!hgPending) {
    hgPending = fetch("/api/heygen/options").then(async (r) => {
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "failed to load HeyGen options");
      hgCache = { avatars: j.avatars ?? [], voices: j.voices ?? [] };
      return hgCache;
    }).finally(() => { hgPending = null; });
  }
  return hgPending;
}

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
  side, name, kind, label, y, multi, edgeCount, onDown, onUp,
}: {
  side: "in" | "out";
  name: string;
  kind: string;
  label?: string;
  y: number;
  multi?: boolean;
  edgeCount?: number;
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
        // Multi-port circles get a thicker border + outer ring so they read
        // as "drop multiple here" without needing a label. Single ports stay
        // the standard 2px circle.
        className={`${
          multi ? "w-4 h-4 border-[3px] ring-2 ring-offset-1 ring-offset-bg-card" : "w-3.5 h-3.5 border-2"
        } rounded-full bg-bg-card cursor-crosshair hover:scale-125 transition-transform`}
        style={{
          borderColor: color,
          ...(multi ? { boxShadow: `0 0 0 1px ${color}33` } : {}),
        }}
        data-port-side={side}
        data-port-kind={kind}
        data-port-id={name}
        data-port-multi={multi ? "true" : undefined}
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
        title={`${label ?? name} · ${kind}${multi ? " · accepts many" : ""}`}
      />
      {/* Edge count badge for multi-ports with at least one connection. */}
      {multi && (edgeCount ?? 0) > 0 && (
        <div
          className="absolute -top-1.5 -right-1.5 min-w-[14px] h-[14px] px-1 rounded-full bg-fg text-bg text-[8px] font-bold leading-[14px] text-center pointer-events-none"
          title={`${edgeCount} reference${edgeCount === 1 ? "" : "s"} connected`}
        >
          {edgeCount}
        </div>
      )}
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
  disabledReason,
}: {
  field: FieldDef;
  value: unknown;
  onChange: (v: unknown) => void;
  /** When set, render this field as greyed-out with a hover tooltip
   *  explaining why the value is ignored (e.g. Kling V3 ignores aspect
   *  and inherits it from the start image). */
  disabledReason?: string;
}) {
  if (field.type === "slider") {
    const num = Number(value ?? field.min);
    return (
      <div
        className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md border border-border bg-bg-subtle text-[10px] text-fg-muted"
        onMouseDown={(e) => e.stopPropagation()}
        title={field.help ?? field.label}
      >
        <span className="truncate max-w-[78px]">{field.label}</span>
        <input
          type="range"
          min={field.min}
          max={field.max}
          step={field.step}
          value={num}
          onChange={(e) => onChange(Number(e.target.value))}
          onMouseDown={(e) => e.stopPropagation()}
          className="w-16 accent-brand cursor-pointer"
        />
        <span className="tabular-nums text-fg whitespace-nowrap">{num}{field.unit ?? ""}</span>
      </div>
    );
  }
  if (field.type !== "select") return null;
  const disabled = Boolean(disabledReason);
  return (
    <div
      className={`inline-flex items-center gap-1 px-2 py-1 rounded-md border text-[10px] ${
        disabled
          ? "border-border bg-bg-subtle/40 text-fg-subtle opacity-50 cursor-not-allowed"
          : "border-border bg-bg-subtle hover:border-border-strong text-fg-muted"
      }`}
      onMouseDown={(e) => e.stopPropagation()}
      title={disabledReason ?? field.label}
    >
      <select
        title={disabledReason ?? field.label}
        disabled={disabled}
        className={`appearance-none bg-transparent border-none outline-none text-[10px] pr-1 max-w-[100px] truncate ${
          disabled ? "text-fg-subtle cursor-not-allowed" : "text-fg cursor-pointer"
        }`}
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
  onExpand,
  expanded,
}: {
  outputs: Record<string, unknown>;
  results?: { value: string; mime?: string }[];
  selectedIdx: number;
  onSelectIdx: (i: number) => void;
  /** Open the URL in a fullscreen lightbox. */
  onExpand?: (url: string) => void;
  /** Inline-expanded node — render a taller preview. */
  expanded?: boolean;
}) {
  const hiddenUrl = typeof outputs.track_url === "string" ? outputs.track_url : null;
  const cleanResults = results ? results.filter((r) => typeof r.value === "string" && r.value !== hiddenUrl && !r.value.includes("screen-track")) : [];
  const list = cleanResults.length > 0 ? cleanResults : Object.entries(outputs).filter(([k, v]) => typeof v === "string" && k !== "track_url" && !k.startsWith("_")).map(([, v]) => ({ value: v as string }));
  if (list.length === 0) return null;
  const current = list[Math.min(selectedIdx, list.length - 1)];
  const url = current.value;
  const canExpand = url && (isImage(url) || isVideo(url));

  return (
    <div className="mb-2">
      <div className="relative group/preview">
        <PreviewMedia url={url} expanded={expanded} />
        {/* Overlay expand button — appears on hover, opens fullscreen view */}
        {canExpand && onExpand && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onExpand(url);
            }}
            onMouseDown={(e) => e.stopPropagation()}
            className="absolute top-1.5 right-1.5 w-7 h-7 rounded-md bg-black/60 hover:bg-black/80 text-white flex items-center justify-center opacity-0 group-hover/preview:opacity-100 transition-opacity backdrop-blur-sm"
            title="View fullscreen"
          >
            <Expand size={13} />
          </button>
        )}
      </div>
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

function PreviewMedia({ url, expanded }: { url: string; expanded?: boolean }) {
  if (!url) return null;
  // Inline-expanded nodes show a bigger preview (max-h-80 = 320px) vs the
  // compact default (max-h-40 = 160px).
  const mediaMax = expanded ? "max-h-80" : "max-h-40";
  if (isVideo(url)) {
    return <video src={url} controls muted className={`w-full ${mediaMax} rounded-md bg-black`} />;
  }
  if (isAudio(url)) {
    return <audio src={url} controls className="w-full" />;
  }
  if (isImage(url) || url.startsWith("data:image")) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={url} alt="" loading="lazy" decoding="async" className={`w-full ${mediaMax} rounded-md object-cover bg-bg-subtle`} />
    );
  }
  // text — compact view with scroll. The full text is always available via
  // the Maximize2 (Expand) button in the node header, which opens the
  // NodeExpandedModal. Inline-expanded shows more (400px vs 160px).
  return (
    <div className="relative rounded-md bg-bg-subtle border border-border text-fg group/text">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          void navigator.clipboard.writeText(url);
        }}
        onMouseDown={(e) => e.stopPropagation()}
        className="absolute top-1 right-1 px-1.5 py-0.5 rounded text-[9px] text-fg-muted bg-bg-card border border-border opacity-0 group-hover/text:opacity-100 transition-opacity hover:text-fg z-10"
        title="Copy full text"
      >
        Copy
      </button>
      <div
        className={`p-2 pr-12 overflow-auto text-[11px] font-mono whitespace-pre-wrap break-words leading-snug nodrag ${
          expanded ? "max-h-[400px]" : "max-h-[160px]"
        }`}
      >
        {url}
      </div>
    </div>
  );
}

function PreviewThumb({ url }: { url: string }) {
  if (isImage(url)) return <img src={url} alt="" loading="lazy" decoding="async" className="w-full h-full object-cover" />;
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
