"use client";

// Global search palette (Cmd/Ctrl+K): projects, workflows, brands, people.
// Type to search, ArrowUp/Down + Enter to jump, Esc to close.
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { Search, Loader2 } from "lucide-react";

type Result = { group: string; label: string; sub?: string; href: string };

export default function SearchPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Result[]>([]);
  const [loading, setLoading] = useState(false);
  const [hl, setHl] = useState(0);
  const [mounted, setMounted] = useState(false);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => setMounted(true), []);

  // Cmd/Ctrl+K anywhere opens the palette.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.code === "KeyK") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    document.addEventListener("keydown", onKey, { capture: true });
    return () => document.removeEventListener("keydown", onKey, { capture: true });
  }, []);

  useEffect(() => {
    if (!open) { setQ(""); setResults([]); setHl(0); }
  }, [open]);

  const runSearch = useCallback((query: string) => {
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(async () => {
      if (query.trim().length < 2) { setResults([]); setLoading(false); return; }
      setLoading(true);
      try {
        const r = await fetch(`/api/search?q=${encodeURIComponent(query.trim())}`);
        const j = (await r.json()) as { results?: Result[] };
        setResults(j.results ?? []);
        setHl(0);
      } catch { setResults([]); }
      finally { setLoading(false); }
    }, 200);
  }, []);

  const go = (r: Result) => { setOpen(false); router.push(r.href); };
  const hlSafe = results.length ? Math.min(hl, results.length - 1) : 0;

  const trigger = (
    <button
      onClick={() => setOpen(true)}
      className="hidden sm:inline-flex items-center gap-2 px-2.5 py-1.5 rounded-md border border-border text-fg-subtle hover:text-fg hover:border-border-strong text-[12px] transition"
      title="Search projects, workflows, brands (Cmd/Ctrl+K)"
    >
      <Search size={12} />
      <span className="hidden lg:inline">Search</span>
      <kbd className="hidden lg:inline text-[9px] border border-border rounded px-1 py-px text-fg-subtle">K</kbd>
    </button>
  );

  return (
    <>
      {trigger}
      {mounted && open && createPortal(
        <div className="fixed inset-0 z-[1100] bg-black/50 backdrop-blur-sm flex items-start justify-center pt-[16vh] p-4"
          onClick={() => setOpen(false)}>
          <div className="w-full max-w-lg glass r-lg overflow-hidden flex flex-col max-h-[60vh] animate-fade-up"
            onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2 px-3.5 py-3 border-b border-border">
              <Search size={14} className="text-fg-subtle shrink-0" />
              <input
                autoFocus
                value={q}
                onChange={(e) => { setQ(e.target.value); runSearch(e.target.value); }}
                onKeyDown={(e) => {
                  if (e.key === "Escape") { setOpen(false); return; }
                  if (results.length === 0) return;
                  if (e.key === "ArrowDown") { e.preventDefault(); setHl((i) => Math.min(i + 1, results.length - 1)); }
                  else if (e.key === "ArrowUp") { e.preventDefault(); setHl((i) => Math.max(i - 1, 0)); }
                  else if (e.key === "Enter") { e.preventDefault(); const r = results[hlSafe]; if (r) go(r); }
                }}
                placeholder="Search projects, workflows, brands, people..."
                className="flex-1 bg-transparent outline-none text-[14px] text-fg placeholder:text-fg-subtle"
              />
              {loading && <Loader2 size={13} className="animate-spin text-fg-subtle shrink-0" />}
            </div>
            <div className="flex-1 overflow-y-auto py-1">
              {results.length === 0 ? (
                <div className="px-4 py-6 text-center text-[12px] text-fg-subtle">
                  {q.trim().length < 2 ? "Type at least 2 characters" : loading ? "Searching..." : "Nothing found"}
                </div>
              ) : (
                results.map((r, i) => {
                  const firstOfGroup = i === 0 || results[i - 1].group !== r.group;
                  return (
                    <div key={`${r.href}-${i}`}>
                      {firstOfGroup && (
                        <div className="px-3.5 pt-2 pb-1 text-[9px] uppercase tracking-wider text-fg-subtle">{r.group}</div>
                      )}
                      <button
                        onMouseDown={(e) => { e.preventDefault(); go(r); }}
                        onMouseEnter={() => setHl(i)}
                        className={`w-full flex items-center justify-between gap-3 px-3.5 py-1.5 text-left ${i === hlSafe ? "bg-bg-hover ring-1 ring-inset ring-brand/40" : "hover:bg-bg-hover"}`}
                      >
                        <span className="text-[13px] text-fg truncate">{r.label}</span>
                        {r.sub && <span className="text-[10px] text-fg-subtle truncate shrink-0 max-w-[45%]">{r.sub}</span>}
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
