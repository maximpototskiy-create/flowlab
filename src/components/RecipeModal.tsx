"use client";

// Compact "generation recipe" viewer usable ANYWHERE (canvas node previews,
// asset drawer, editor bin): model, prompt, refs, settings, author + copy
// buttons and a jump to the source workflow. Looks the asset up by id or by
// media URL (token-proof - matching is done on the storage path server-side).
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { Copy, ExternalLink, Loader2, X } from "lucide-react";

type Provenance = {
  model: string | null; prompt: string | null; seed: string | null;
  refs: string[]; nodeType: string | null; config: Record<string, unknown>;
  author: string | null;
  workflow: { id: string; projectId: string; name: string } | null;
};

export default function RecipeModal({ assetId, url, onClose }: { assetId?: string; url?: string; onClose: () => void }) {
  const [prov, setProv] = useState<Provenance | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "missing">("loading");
  const [copied, setCopied] = useState("");

  useEffect(() => {
    let dead = false;
    const qs = assetId ? `id=${encodeURIComponent(assetId)}` : `url=${encodeURIComponent(url ?? "")}`;
    fetch(`/api/assets/provenance?${qs}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (dead) return;
        if (j && !j.error) { setProv(j); setState("ready"); } else setState("missing");
      })
      .catch(() => { if (!dead) setState("missing"); });
    return () => { dead = true; };
  }, [assetId, url]);

  const copy = (label: string, text: string) => {
    void navigator.clipboard.writeText(text);
    setCopied(label); setTimeout(() => setCopied(""), 1200);
  };

  return createPortal(
    <div className="fixed inset-0 z-[1200] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose} onPointerDown={(e) => e.stopPropagation()}>
      <div className="w-full max-w-md glass r-lg p-4 space-y-3 max-h-[80vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <span className="text-[10px] uppercase tracking-wider text-fg-subtle">Generation recipe</span>
          <button onClick={onClose} className="text-fg-subtle hover:text-fg"><X size={14} /></button>
        </div>

        {state === "loading" && (
          <div className="py-8 text-center text-fg-subtle"><Loader2 size={16} className="animate-spin inline" /></div>
        )}
        {state === "missing" && (
          <div className="py-6 text-center text-[12px] text-fg-subtle">
            No recipe for this file - it is an upload or predates recipe tracking.
          </div>
        )}
        {state === "ready" && prov && (
          <>
            {prov.model && (
              <div className="flex items-center justify-between gap-2 text-[12px]">
                <span className="text-fg-subtle">Model</span>
                <span className="text-fg-muted truncate">{prov.model}</span>
              </div>
            )}
            {prov.prompt && (
              <div>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[9px] uppercase tracking-wider text-fg-subtle">Prompt</span>
                  <button onClick={() => copy("prompt", prov.prompt!)} className="text-[9px] text-fg-subtle hover:text-brand inline-flex items-center gap-1">
                    <Copy size={9} /> {copied === "prompt" ? "Copied" : "Copy"}
                  </button>
                </div>
                <p className="text-[12px] text-fg-muted leading-snug max-h-32 overflow-auto whitespace-pre-wrap">{prov.prompt}</p>
              </div>
            )}
            {prov.refs.length > 0 && (
              <div>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[9px] uppercase tracking-wider text-fg-subtle">References ({prov.refs.length})</span>
                  <button onClick={() => copy("refs", prov.refs.join("\n"))} className="text-[9px] text-fg-subtle hover:text-brand inline-flex items-center gap-1">
                    <Copy size={9} /> {copied === "refs" ? "Copied" : "Copy URLs"}
                  </button>
                </div>
                <div className="flex gap-1.5 overflow-x-auto pb-1">
                  {prov.refs.map((r, i) => (
                    <a key={i} href={r} target="_blank" rel="noopener noreferrer"
                      className="shrink-0 w-12 h-12 rounded-md overflow-hidden border border-border hover:border-brand bg-black">
                      {/\.(mp4|webm|mov)(\?|$)/i.test(r.split("?")[0])
                        ? <video src={r} muted playsInline preload="metadata" className="w-full h-full object-cover" />
                        // eslint-disable-next-line @next/next/no-img-element
                        : <img src={r} alt="" loading="lazy" className="w-full h-full object-cover" />}
                    </a>
                  ))}
                </div>
              </div>
            )}
            <div className="flex flex-wrap gap-1.5 pt-1">
              <button
                onClick={() => copy("recipe", [
                  prov.model ? `Model: ${prov.model}` : "",
                  prov.prompt ? `Prompt: ${prov.prompt}` : "",
                  prov.seed ? `Seed: ${prov.seed}` : "",
                  Object.keys(prov.config).length ? `Settings: ${JSON.stringify(prov.config)}` : "",
                  prov.refs.length ? `Refs:\n${prov.refs.join("\n")}` : "",
                ].filter(Boolean).join("\n"))}
                className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md border border-border text-[10px] text-fg-muted hover:text-fg hover:border-border-strong">
                <Copy size={10} /> {copied === "recipe" ? "Recipe copied" : "Copy full recipe"}
              </button>
              {prov.workflow && (
                <Link href={`/projects/${prov.workflow.projectId}/workflows/${prov.workflow.id}`}
                  className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md border border-border text-[10px] text-fg-muted hover:text-brand hover:border-brand/60">
                  <ExternalLink size={10} /> Open workflow
                </Link>
              )}
            </div>
            {prov.author && <div className="text-[10px] text-fg-subtle">Generated by {prov.author}</div>}
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
