"use client";

import { modelsForMode, getVideoModel, VIDEO_MODE_LABELS, type VideoMode } from "@/lib/canvas/videoModels";

/**
 * Smart Mode → Model → Duration → Resolution controls for the Video Generation
 * node. Shared by the compact node body and the expanded modal so both stay in
 * sync. The model list is filtered to the chosen mode and grouped by family;
 * duration is a 1s slider for range models and fixed buttons otherwise.
 */
export default function VideoGenControls({
  config,
  onConfigChange,
  size = "compact",
}: {
  config: Record<string, unknown>;
  onConfigChange: (key: string, value: unknown) => void;
  size?: "compact" | "large";
}) {
  const mode = String(config.mode ?? "image") as VideoMode;
  const modelId = String(config.model ?? "");
  const groups = modelsForMode(mode);
  const model = getVideoModel(modelId);
  const dur = Number(config.duration ?? 5);
  const resolution = String(config.resolution ?? "");
  const big = size === "large";
  const sel = `mt-0.5 w-full bg-bg-card border border-border rounded px-2 py-1.5 ${big ? "text-[13px]" : "text-[11px]"} text-fg outline-none`;
  const lbl = `text-[9px] uppercase tracking-wider text-fg-subtle font-medium`;
  const inModeGroups = groups.some((g) => g.models.some((m) => m.id === modelId));

  return (
    <div className={`${big ? "space-y-3" : "space-y-2"} ${big ? "text-[13px]" : "text-[11px]"}`} onPointerDown={(e) => e.stopPropagation()}>
      <label className="block">
        <span className={lbl}>Mode</span>
        <select value={mode} onChange={(e) => onConfigChange("mode", e.target.value)} className={sel}>
          {VIDEO_MODE_LABELS.map((m) => <option key={m.value} value={m.value}>{m.label} — {m.hint}</option>)}
        </select>
      </label>

      <label className="block">
        <span className={lbl}>Model</span>
        <select value={modelId} onChange={(e) => onConfigChange("model", e.target.value)} className={sel}>
          {!inModeGroups && modelId && (
            <option value={modelId}>{getVideoModel(modelId)?.label ?? "Current model"} (current)</option>
          )}
          {groups.map((g) => (
            <optgroup key={g.family} label={g.family}>
              {g.models.map((m) => <option key={m.id} value={m.id}>{m.label}{m.recommended ? " ⭐" : ""}</option>)}
            </optgroup>
          ))}
        </select>
      </label>

      {model && (model.duration.kind === "range" ? (
        <div>
          <div className="flex items-center justify-between">
            <span className={lbl}>Duration</span>
            <span className="text-fg font-medium">{dur}s</span>
          </div>
          <input
            type="range"
            min={model.duration.min}
            max={model.duration.max}
            step={model.duration.step}
            value={dur}
            onChange={(e) => onConfigChange("duration", String(Number(e.target.value)))}
            onPointerDown={(e) => e.stopPropagation()}
            className="w-full mt-1 accent-brand cursor-pointer"
          />
          <div className="flex justify-between text-[8px] text-fg-subtle"><span>{model.duration.min}s</span><span>{model.duration.max}s</span></div>
        </div>
      ) : (
        <div>
          <span className={lbl}>Duration</span>
          <div className="flex gap-1 mt-0.5">
            {model.duration.values.map((v) => (
              <button key={v} type="button" onClick={() => onConfigChange("duration", String(v))}
                className={`flex-1 py-1 rounded border ${big ? "text-[13px]" : "text-[11px]"} ${dur === v ? "border-brand bg-brand/10 text-brand" : "border-border text-fg-muted hover:border-brand/50"}`}>{v}s</button>
            ))}
          </div>
        </div>
      ))}

      {model?.resolutions && model.resolutions.length > 0 && (
        <label className="block">
          <span className={lbl}>Resolution</span>
          <select value={resolution || model.resolutions[0]} onChange={(e) => onConfigChange("resolution", e.target.value)} className={sel}>
            {model.resolutions.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </label>
      )}

      {(mode === "video-to-video" || mode === "references") && (
        <div className="rounded-md border border-border bg-bg/40 px-2 py-1.5 text-[10px] text-fg-muted leading-snug">
          Connected inputs are referenced automatically — just describe what you want (e.g. “replace the phone screen with the reference”). To control placement yourself, write <span className="text-fg">@Image1</span> / <span className="text-fg">[Image1]</span> in the prompt.
          {mode === "video-to-video" && <> Source video must be .mp4/.mov, 3–10s, ≥720px; duration & aspect follow the source.</>}
        </div>
      )}

      {model?.audio && (
        <label className="flex items-center gap-1.5 text-[10px] text-fg-muted">
          <input type="checkbox" checked={Boolean(config.generate_audio)} onChange={(e) => onConfigChange("generate_audio", e.target.checked)} />
          Generate audio
        </label>
      )}
    </div>
  );
}
