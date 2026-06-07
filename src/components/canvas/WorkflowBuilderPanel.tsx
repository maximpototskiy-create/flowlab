"use client";

import { useState } from "react";
import { Sparkles, Loader2, X, Plus, RefreshCw, AlertTriangle } from "lucide-react";
import type { Graph } from "@/lib/canvas/types";

type BuildResult = { graph: Graph; summary: string; warnings: string[] };

const EXAMPLES = [
  "Рекламный ролик: хук на 2 сек, 3 сцены с продуктом, музыка, сборка в MP4",
  "Из текста идеи — 4 варианта картинки-постера, апскейл лучшего, экспорт",
  "Говорящая голова: озвучка по скрипту + lipsync, экспорт видео",
];

export default function WorkflowBuilderPanel({
  brandHint,
  onApply,
  onClose,
}: {
  brandHint?: string | null;
  onApply: (graph: Graph, mode: "insert" | "replace") => void;
  onClose: () => void;
}) {
  const [brief, setBrief] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BuildResult | null>(null);

  async function build() {
    if (!brief.trim() || loading) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/agent/build-workflow", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brief, brandHint: brandHint ?? undefined }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Build failed");
      } else {
        setResult(data as BuildResult);
      }
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[900] flex justify-end bg-black/40" onClick={onClose}>
      <div
        className="w-full max-w-md h-full bg-bg border-l border-border flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="h-12 shrink-0 border-b border-border px-4 flex items-center justify-between">
          <div className="flex items-center gap-2 text-fg text-[13px] font-medium">
            <Sparkles size={14} className="text-brand" />
            Build with AI
          </div>
          <button onClick={onClose} className="text-fg-subtle hover:text-fg">
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          <div>
            <label className="text-[11px] uppercase tracking-wider text-fg-subtle">Describe the workflow</label>
            <textarea
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") build();
              }}
              rows={5}
              placeholder="Например: рекламный ролик из хука, 3 сцен и музыки, со сборкой в MP4…"
              className="mt-1.5 w-full bg-bg-card border border-border rounded-md p-2.5 text-[12px] text-fg outline-none focus:border-brand resize-none"
            />
            <div className="mt-2 flex flex-wrap gap-1.5">
              {EXAMPLES.map((ex, i) => (
                <button
                  key={i}
                  onClick={() => setBrief(ex)}
                  className="px-2 py-1 rounded-md border border-border text-fg-muted hover:text-fg hover:border-border-strong text-[10px]"
                >
                  {ex.length > 42 ? ex.slice(0, 42) + "…" : ex}
                </button>
              ))}
            </div>
          </div>

          <button
            onClick={build}
            disabled={loading || !brief.trim()}
            className="w-full inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-md bg-brand text-black font-medium text-[12px] disabled:opacity-50"
          >
            {loading ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
            {loading ? "Строю граф…" : "Build"}
          </button>
          <p className="text-[10px] text-fg-subtle text-center -mt-2">⌘/Ctrl + Enter</p>

          {error && (
            <div className="rounded-md border border-red-500/40 bg-red-500/10 p-2.5 text-[11px] text-red-400">
              {error}
            </div>
          )}

          {result && (
            <div className="space-y-3">
              <div className="rounded-md border border-border bg-bg-card p-3">
                <div className="text-[10px] uppercase tracking-wider text-fg-subtle mb-1">Summary</div>
                <p className="text-[12px] text-fg">{result.summary}</p>
                <div className="text-[11px] text-fg-muted mt-2">
                  {result.graph.nodes.length} nodes · {result.graph.edges.length} connections
                </div>
              </div>

              <div className="rounded-md border border-border overflow-hidden">
                <div className="text-[10px] uppercase tracking-wider text-fg-subtle px-3 py-2 bg-bg-card">
                  Nodes
                </div>
                <ul className="divide-y divide-border/60 max-h-52 overflow-y-auto">
                  {result.graph.nodes.map((n) => (
                    <li key={n.id} className="px-3 py-2 text-[11px] flex items-center justify-between gap-2">
                      <span className="text-fg">{n.type}</span>
                      <span className="text-fg-subtle truncate max-w-[55%] text-right">
                        {String(
                          (n.config?.prompt as string) ||
                            (n.config?.text as string) ||
                            (n.config?.script as string) ||
                            "",
                        ).slice(0, 60)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>

              {result.warnings.length > 0 && (
                <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5">
                  <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-amber-400 mb-1">
                    <AlertTriangle size={11} /> {result.warnings.length} warning(s)
                  </div>
                  <ul className="space-y-0.5 text-[10px] text-amber-300/90 max-h-24 overflow-y-auto">
                    {result.warnings.map((w, i) => (
                      <li key={i}>· {w}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer actions */}
        {result && (
          <div className="shrink-0 border-t border-border p-3 flex items-center gap-2">
            <button
              onClick={() => onApply(result.graph, "insert")}
              className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-md border border-border text-fg hover:border-border-strong text-[12px]"
            >
              <Plus size={13} /> Insert
            </button>
            <button
              onClick={() => onApply(result.graph, "replace")}
              className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-md bg-brand text-black font-medium text-[12px]"
            >
              <RefreshCw size={13} /> Replace canvas
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
