"use client";

// Scene builder for videoGen mode === "multi-shot".
// Rendered inside NodeExpandedModal when the active node is a videoGen
// in multi-shot mode. Manages a list of { id, prompt, duration } scenes
// stored on node.config.scenes. The runner reads this array and packs
// it into Kling's native `multi_prompt` field — one API call returns
// one video with N scenes stitched server-side.

import { useCallback } from "react";
import { Plus, X, ArrowUp, ArrowDown } from "lucide-react";

export type Scene = {
  id: string;
  prompt: string;
  duration: string; // "3".."15" — string because Kling API expects string
};

const DURATION_OPTIONS = ["3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "15"];

function nextSceneId(scenes: Scene[]): string {
  // Stable, non-random IDs — derive from current count + a small salt
  // so React keys stay distinct even after reorder/remove cycles.
  const used = new Set(scenes.map((s) => s.id));
  let n = scenes.length + 1;
  while (used.has(`scene-${n}`)) n++;
  return `scene-${n}`;
}

export default function SceneBuilder({
  scenes,
  onChange,
}: {
  scenes: Scene[];
  onChange: (next: Scene[]) => void;
}) {
  const updateScene = useCallback(
    (id: string, patch: Partial<Scene>) => {
      onChange(scenes.map((s) => (s.id === id ? { ...s, ...patch } : s)));
    },
    [scenes, onChange],
  );

  const removeScene = useCallback(
    (id: string) => {
      // Always keep at least one scene — empty list breaks the
      // runner's "≥1 scene" guard and confuses the UI.
      if (scenes.length <= 1) return;
      onChange(scenes.filter((s) => s.id !== id));
    },
    [scenes, onChange],
  );

  const moveScene = useCallback(
    (id: string, dir: -1 | 1) => {
      const idx = scenes.findIndex((s) => s.id === id);
      const target = idx + dir;
      if (idx < 0 || target < 0 || target >= scenes.length) return;
      const next = scenes.slice();
      [next[idx], next[target]] = [next[target], next[idx]];
      onChange(next);
    },
    [scenes, onChange],
  );

  const addScene = useCallback(() => {
    onChange([
      ...scenes,
      { id: nextSceneId(scenes), prompt: "", duration: "5" },
    ]);
  }, [scenes, onChange]);

  const totalDuration = scenes.reduce((sum, s) => sum + Number(s.duration || 0), 0);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <label className="block text-[10px] uppercase tracking-wider text-fg-muted font-medium">
          Scene constructor · {scenes.length} scene{scenes.length !== 1 ? "s" : ""} · ~{totalDuration}s total
        </label>
      </div>

      <div className="space-y-2">
        {scenes.map((scene, idx) => (
          <div
            key={scene.id}
            className="rounded-lg bg-bg-subtle border border-border p-3 space-y-2"
          >
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-fg-muted font-medium">
                Scene {idx + 1}
              </span>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => moveScene(scene.id, -1)}
                  disabled={idx === 0}
                  className="w-6 h-6 rounded flex items-center justify-center text-fg-muted hover:bg-bg-hover hover:text-fg disabled:opacity-30 disabled:cursor-not-allowed"
                  title="Move up"
                >
                  <ArrowUp size={12} strokeWidth={1.5} />
                </button>
                <button
                  type="button"
                  onClick={() => moveScene(scene.id, 1)}
                  disabled={idx === scenes.length - 1}
                  className="w-6 h-6 rounded flex items-center justify-center text-fg-muted hover:bg-bg-hover hover:text-fg disabled:opacity-30 disabled:cursor-not-allowed"
                  title="Move down"
                >
                  <ArrowDown size={12} strokeWidth={1.5} />
                </button>
                <button
                  type="button"
                  onClick={() => removeScene(scene.id)}
                  disabled={scenes.length <= 1}
                  className="w-6 h-6 rounded flex items-center justify-center text-fg-muted hover:bg-red-500/10 hover:text-red-500 disabled:opacity-30 disabled:cursor-not-allowed"
                  title={scenes.length <= 1 ? "At least one scene required" : "Remove scene"}
                >
                  <X size={12} strokeWidth={1.5} />
                </button>
              </div>
            </div>

            <textarea
              className="w-full bg-bg-card border border-border rounded-md px-3 py-2 text-[12px] text-fg outline-none focus:border-brand resize-y min-h-[80px] leading-relaxed"
              placeholder="Describe this scene…"
              value={scene.prompt}
              onChange={(e) => updateScene(scene.id, { prompt: e.target.value })}
            />

            <div className="flex items-center gap-2">
              <span className="text-[10px] text-fg-muted">Duration</span>
              <select
                className="bg-bg-card border border-border rounded px-2 py-1 text-[11px] text-fg outline-none focus:border-brand"
                value={scene.duration}
                onChange={(e) => updateScene(scene.id, { duration: e.target.value })}
              >
                {DURATION_OPTIONS.map((d) => (
                  <option key={d} value={d}>
                    {d}s
                  </option>
                ))}
              </select>
            </div>
          </div>
        ))}
      </div>

      <button
        type="button"
        onClick={addScene}
        className="w-full rounded-lg border border-dashed border-border hover:border-brand hover:bg-brand/5 px-3 py-2.5 text-[12px] text-fg-muted hover:text-brand flex items-center justify-center gap-1.5 transition-colors"
      >
        <Plus size={14} strokeWidth={1.5} />
        Add scene
      </button>

      <div className="text-[10px] text-fg-subtle italic">
        Each scene becomes one shot in the final video. Order matters — drag
        order with the arrow buttons. Only Kling V3 and O3 models support
        multi-shot.
      </div>
    </div>
  );
}
