"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { Loader2, Upload, X, Music, Video as VideoIcon } from "lucide-react";

type BrandAsset = { id: string; url: string; kind: string; category: string; label: string | null; embedStatus?: string | null };

const CATEGORIES: { value: string; label: string }[] = [
  { value: "logo", label: "Logo" },
  { value: "ui", label: "UI screenshot" },
  { value: "store", label: "Store screenshot" },
  { value: "graphic", label: "Graphic element" },
  { value: "overlay", label: "Overlay / plate" },
  { value: "music", label: "Music" },
  { value: "sound", label: "Sound FX" },
  { value: "reference", label: "Reference" },
  { value: "hook", label: "Hook" },
  { value: "body", label: "Body" },
  { value: "packshot", label: "Packshot" },
  { value: "other", label: "Other" },
];

function kindFromFile(file: File): string {
  if (file.type.startsWith("video")) return "video";
  if (file.type.startsWith("audio")) return "audio";
  return "image";
}

export default function BrandAssetsManager({ brandId }: { brandId: string }) {
  const [assets, setAssets] = useState<BrandAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [reindexing, setReindexing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const [category, setCategory] = useState("logo");
  const [filter, setFilter] = useState("all");
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/brand-assets?brandId=${brandId}`);
      const data = await res.json();
      setAssets(data.assets ?? []);
    } catch {
      setAssets([]);
    } finally {
      setLoading(false);
    }
  }, [brandId]);

  useEffect(() => { load(); }, [load]);

  // While any video/audio is still embedding, poll the lightweight refresh
  // endpoint (bounded, sequential) and reload the list. The list GET itself
  // is now instant and never blocks on TwelveLabs.
  useEffect(() => {
    const stillEmbedding = assets.some((a) => (a.kind === "video" || a.kind === "audio") && a.embedStatus === "processing");
    if (!stillEmbedding) return;
    const t = setInterval(async () => {
      try {
        await fetch("/api/brand-assets/refresh-embeds", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ brandId }),
        });
      } catch {
        /* ignore */
      }
      load();
    }, 12000);
    return () => clearInterval(t);
  }, [assets, load, brandId]);

  async function importFromDrive() {
    setImporting(true);
    setImportMsg("Connecting to Drive…");
    let totalNew = 0;
    let importedSum = 0;
    let videosSum = 0;
    let skippedSum = 0;
    let failedSum = 0;
    try {
      // Loop batches until nothing remains. Each call imports up to 20 files
      // and returns how many are left, so we can show real progress and pull
      // everything (images + videos) without manual re-runs.
      // Safety cap on iterations to avoid any accidental infinite loop.
      for (let i = 0; i < 100; i++) {
        const res = await fetch("/api/drive/import", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ brandId }),
        });
        const d = await res.json();
        if (d.error) {
          setImportMsg(`Error: ${d.error}`);
          break;
        }
        if (i === 0) totalNew = d.newFound ?? 0;
        importedSum += d.imported ?? 0;
        videosSum += d.videos ?? 0;
        skippedSum += d.skippedLarge ?? 0;
        failedSum += d.failed ?? 0;

        await load();

        if (totalNew === 0) {
          setImportMsg("Nothing new in Drive.");
          break;
        }
        const done = importedSum + skippedSum + failedSum;
        setImportMsg(`Importing… ${done}/${totalNew}${d.remaining ? ` (${d.remaining} left)` : ""}`);

        if (!d.remaining) {
          const parts = [`Imported ${importedSum}`];
          if (videosSum) parts.push(`${videosSum} video/audio indexing`);
          if (skippedSum) parts.push(`${skippedSum} too large (skipped)`);
          if (failedSum) parts.push(`${failedSum} failed`);
          setImportMsg(parts.join(" · "));
          break;
        }
        // Stop if a batch made no progress at all (avoids looping).
        if ((d.imported ?? 0) === 0 && (d.skippedLarge ?? 0) === 0 && (d.failed ?? 0) === 0) {
          setImportMsg(`Stopped — ${importedSum} imported, ${d.remaining} could not be processed.`);
          break;
        }
      }
    } catch {
      setImportMsg("Import failed (network).");
    } finally {
      setImporting(false);
    }
  }

  async function reindexFailed() {
    setReindexing(true);
    try {
      await fetch("/api/brand-assets/reembed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brandId }),
      });
      await load();
    } catch {
      /* ignore */
    } finally {
      setReindexing(false);
    }
  }

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        const fd = new FormData();
        fd.append("file", file);
        const up = await fetch("/api/upload", { method: "POST", body: fd });
        if (!up.ok) continue;
        const { cdnUrl } = await up.json();
        if (!cdnUrl) continue;
        await fetch("/api/brand-assets", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ brandId, url: cdnUrl, kind: kindFromFile(file), category, label: file.name }),
        });
      }
      await load();
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  async function remove(id: string) {
    setAssets((prev) => prev.filter((a) => a.id !== id));
    await fetch(`/api/brand-assets?id=${id}`, { method: "DELETE" });
  }

  const visible = filter === "all" ? assets : assets.filter((a) => a.category === filter);
  const usedCategories = ["all", ...CATEGORIES.map((c) => c.value).filter((c) => assets.some((a) => a.category === c))];

  return (
    <div className="space-y-3">
      {/* Upload row */}
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          className="bg-bg border border-border rounded-md px-2.5 py-2 text-[12px] text-fg"
        >
          {CATEGORIES.map((c) => (
            <option key={c.value} value={c.value}>{c.label}</option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => fileInput.current?.click()}
          disabled={uploading}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md border border-brand text-brand text-[12px] hover:bg-brand/10 transition disabled:opacity-60"
        >
          {uploading ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
          {uploading ? "Uploading…" : "Upload to this category"}
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="image/*,video/*,audio/*"
          multiple
          className="hidden"
          onChange={(e) => handleFiles(e.target.files)}
        />
        <span className="text-[10px] text-fg-subtle">Images, video, audio.</span>
        <button
          type="button"
          onClick={importFromDrive}
          disabled={importing}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md border border-border text-fg-muted text-[12px] hover:text-fg transition disabled:opacity-60"
          title="Pull new files from this brand's Google Drive folder"
        >
          {importing ? <Loader2 size={13} className="animate-spin" /> : null}
          {importing ? "Importing…" : "Import from Drive"}
        </button>
        {assets.some((a) => a.embedStatus === "failed") && (
          <button
            type="button"
            onClick={reindexFailed}
            disabled={reindexing}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md border border-border text-fg-muted text-[12px] hover:text-fg transition disabled:opacity-60"
            title="Re-run semantic indexing for assets that failed"
          >
            {reindexing ? <Loader2 size={13} className="animate-spin" /> : null}
            {reindexing ? "Re-indexing…" : "Re-index failed"}
          </button>
        )}
      </div>

      {importMsg && <p className="text-[11px] text-fg-muted">{importMsg}</p>}

      {/* Category filter */}
      {usedCategories.length > 1 && (
        <div className="flex flex-wrap gap-1">
          {usedCategories.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setFilter(c)}
              className={`px-2 py-0.5 rounded-full text-[10px] border transition ${
                filter === c ? "bg-brand/15 border-brand text-brand" : "border-border text-fg-muted hover:text-fg"
              }`}
            >
              {c === "all" ? "All" : CATEGORIES.find((x) => x.value === c)?.label ?? c}
            </button>
          ))}
        </div>
      )}

      {/* Grid */}
      {loading ? (
        <div className="flex items-center justify-center py-8 text-fg-subtle"><Loader2 size={16} className="animate-spin" /></div>
      ) : visible.length === 0 ? (
        <p className="text-[11px] text-fg-subtle py-6 text-center border border-dashed border-border rounded-md">
          No brand assets yet. Pick a category and upload.
        </p>
      ) : (
        <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
          {visible.map((a) => (
            <div key={a.id} className="relative group aspect-square rounded-md overflow-hidden border border-border bg-bg">
              {a.kind === "image" && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={a.url} alt="" className="w-full h-full object-cover" />
              )}
              {a.kind === "video" && (
                <div className="w-full h-full flex items-center justify-center bg-black">
                  <video src={a.url} className="w-full h-full object-cover" muted preload="metadata" />
                  <VideoIcon size={16} className="absolute text-white/80" />
                </div>
              )}
              {a.kind === "audio" && (
                <div className="w-full h-full flex items-center justify-center"><Music size={20} className="text-fg-subtle" /></div>
              )}
              <span className="absolute top-1 left-1 px-1 py-0.5 rounded bg-black/55 text-[7px] uppercase text-white/85">
                {a.category}
              </span>
              {a.embedStatus && a.kind !== "audio" && (
                <span
                  className={`absolute bottom-1 left-1 px-1 py-0.5 rounded text-[7px] uppercase ${
                    a.embedStatus === "ready"
                      ? "bg-emerald-600/80 text-white"
                      : a.embedStatus === "failed"
                        ? "bg-red-600/80 text-white"
                        : "bg-amber-500/80 text-black"
                  }`}
                  title="Semantic search index"
                >
                  {a.embedStatus === "ready" ? "searchable" : a.embedStatus === "failed" ? "index failed" : "indexing…"}
                </span>
              )}
              <button
                type="button"
                onClick={() => remove(a.id)}
                className="absolute top-1 right-1 w-5 h-5 rounded bg-black/55 text-white/85 opacity-0 group-hover:opacity-100 flex items-center justify-center hover:bg-red-500/80 transition"
              >
                <X size={11} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
