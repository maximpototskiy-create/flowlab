"use client";

import { useEffect, useState } from "react";
import { Loader2, Search } from "lucide-react";

type TLIndex = { id: string; name: string };
type TLClip = {
  indexId: string;
  videoId: string;
  score: number;
  start: number;
  end: number;
  thumbnailUrl: string | null;
  confidence: string | null;
};

function fmt(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// Semantic search across TwelveLabs indexes (Marengo 3.0). Type a query →
// searches all (or selected) indexes → ranked video clips.
export default function AssetSearchPage() {
  const [indexes, setIndexes] = useState<TLIndex[]>([]);
  const [selected, setSelected] = useState<string[]>([]); // empty = all
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [clips, setClips] = useState<TLClip[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [searchedCount, setSearchedCount] = useState(0);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/twelvelabs/indexes");
        const data = await res.json();
        setIndexes(data.indexes ?? []);
        if (data.error) setError(data.error);
      } catch {
        /* ignore */
      }
    })();
  }, []);

  async function run() {
    if (!query.trim()) return;
    setLoading(true);
    setError(null);
    setClips(null);
    try {
      const res = await fetch("/api/twelvelabs/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, indexIds: selected }),
      });
      const data = await res.json();
      if (data.error) {
        setError(data.error);
      } else {
        setClips(data.clips ?? []);
        setSearchedCount(data.searchedIndexes ?? 0);
      }
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  }

  function toggleIndex(id: string) {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-4">
      <div>
        <h1 className="text-lg font-semibold text-fg">Asset search</h1>
        <p className="text-[12px] text-fg-muted mt-0.5">
          Semantic search across your TwelveLabs video indexes. Describe what you need — finds matching clips by content.
        </p>
      </div>

      {/* Index selector */}
      {indexes.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-[10px] uppercase tracking-wider text-fg-subtle">
            Indexes ({selected.length === 0 ? "all" : selected.length} selected)
          </div>
          <div className="flex flex-wrap gap-1">
            <button
              onClick={() => setSelected([])}
              className={`px-2 py-0.5 rounded-full text-[10px] border transition ${
                selected.length === 0 ? "bg-brand/15 border-brand text-brand" : "border-border text-fg-muted hover:text-fg"
              }`}
            >
              All
            </button>
            {indexes.map((ix) => (
              <button
                key={ix.id}
                onClick={() => toggleIndex(ix.id)}
                title={ix.id}
                className={`px-2 py-0.5 rounded-full text-[10px] border transition ${
                  selected.includes(ix.id) ? "bg-brand/15 border-brand text-brand" : "border-border text-fg-muted hover:text-fg"
                }`}
              >
                {ix.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Query */}
      <div className="flex gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && run()}
          placeholder="e.g. energetic hook with app UI and upbeat music"
          className="flex-1 bg-bg border border-border rounded-md p-2.5 text-[13px] text-fg outline-none focus:border-brand"
        />
        <button
          onClick={run}
          disabled={loading || !query.trim()}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-brand text-black font-medium text-[12px] disabled:opacity-60"
        >
          {loading ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
          Search
        </button>
      </div>

      {error && <p className="text-[12px] text-red-400">{error}</p>}
      {loading && <p className="text-[11px] text-fg-subtle">Searching your indexes…</p>}

      {clips && (
        <div className="space-y-2">
          <div className="text-[11px] text-fg-muted">
            {clips.length} clip{clips.length === 1 ? "" : "s"} across {searchedCount} index{searchedCount === 1 ? "" : "es"}
          </div>
          {clips.length === 0 ? (
            <p className="text-[12px] text-fg-subtle py-6 text-center border border-dashed border-border rounded-md">
              Nothing matched. Try different wording.
            </p>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
              {clips.map((c, i) => (
                <div key={`${c.videoId}-${i}`} className="rounded-md overflow-hidden border border-border bg-bg-card">
                  <div className="aspect-video bg-black flex items-center justify-center">
                    {c.thumbnailUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={c.thumbnailUrl} alt="" className="w-full h-full object-cover" loading="lazy" />
                    ) : (
                      <span className="text-[10px] text-fg-subtle">no preview</span>
                    )}
                  </div>
                  <div className="p-2 space-y-0.5">
                    <div className="flex items-center justify-between text-[10px]">
                      <span className="text-brand font-medium">{(c.score).toFixed(1)}</span>
                      <span className="text-fg-subtle">{fmt(c.start)}–{fmt(c.end)}</span>
                    </div>
                    <div className="text-[9px] text-fg-subtle truncate" title={c.videoId}>{c.videoId}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
