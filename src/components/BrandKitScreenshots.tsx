"use client";

import { useRef, useState } from "react";
import { Upload, X, ImageIcon } from "lucide-react";

// ─────────────────────────────────────────────────────────────────────────────
// BrandKitScreenshots
//
// Manages the brand's UI screenshot list (app store screenshots, in-app
// reference photos). Stored in BrandKit.uiScreenshots as a newline-separated
// list of CDN URLs. This component renders thumbnails, lets the user upload
// new files (drag-drop or file picker), and writes the current list to a
// hidden <input name="uiScreenshots"> so it submits with the parent form.
//
// Why screenshots are kept here and not in the Asset table:
//   • They're brand-level metadata, not workflow-level deliverables
//   • The "Brand Assets" canvas node will pull them via brand_id later
//   • Cleaner to manage them as a list of URLs vs full Asset rows
// ─────────────────────────────────────────────────────────────────────────────

export default function BrandKitScreenshots({
  initialValue,
  name = "uiScreenshots",
}: {
  initialValue: string;
  name?: string;
}) {
  // Parse newline-separated value into array.
  const [urls, setUrls] = useState<string[]>(() =>
    initialValue
      .split("\n")
      .map((u) => u.trim())
      .filter((u) => u.startsWith("http")),
  );
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      const newUrls: string[] = [];
      for (const file of Array.from(files)) {
        const fd = new FormData();
        fd.append("file", file);
        const res = await fetch("/api/upload", { method: "POST", body: fd });
        if (!res.ok) {
          console.error("Upload failed:", await res.text());
          continue;
        }
        const data = (await res.json()) as { cdnUrl?: string };
        if (data.cdnUrl) newUrls.push(data.cdnUrl);
      }
      if (newUrls.length > 0) setUrls((prev) => [...prev, ...newUrls]);
    } finally {
      setUploading(false);
      // Clear native input so picking the same file twice still fires onChange.
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  function removeAt(idx: number) {
    setUrls((prev) => prev.filter((_, i) => i !== idx));
  }

  // The serialised form value the parent form picks up — newline-separated
  // so it matches the existing storage convention for other multi-line BrandKit
  // fields (colors, fonts, etc).
  const serialised = urls.join("\n");

  return (
    <div>
      {/* Hidden input that submits the actual value. Lives outside the
          grid so the form picks it up regardless of which thumbnail is
          rendered above. */}
      <input type="hidden" name={name} value={serialised} />

      {/* Thumbnail grid */}
      {urls.length > 0 && (
        <div className="grid grid-cols-3 sm:grid-cols-4 gap-2 mb-3">
          {urls.map((u, i) => (
            <div
              key={`${u}-${i}`}
              className="relative aspect-[9/16] rounded-md overflow-hidden border border-border bg-bg-card group"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={u}
                alt=""
                className="w-full h-full object-cover"
                loading="lazy"
              />
              <button
                type="button"
                onClick={() => removeAt(i)}
                className="absolute top-1 right-1 w-6 h-6 rounded-full bg-black/60 hover:bg-red-500 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition"
                title="Remove"
              >
                <X size={11} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Upload zone — drag-drop OR click-to-pick. */}
      <div
        className={`rounded-md border border-dashed transition cursor-pointer p-4 text-center text-[12px] ${
          uploading ? "border-brand bg-brand/5" : "border-border hover:border-border-strong bg-bg-card"
        }`}
        onClick={() => fileInput.current?.click()}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          handleFiles(e.dataTransfer.files);
        }}
      >
        <div className="flex items-center justify-center gap-2 text-fg-muted">
          {uploading ? (
            <span>Uploading…</span>
          ) : (
            <>
              <Upload size={14} />
              <span>Drop screenshots here or click</span>
              <ImageIcon size={12} className="opacity-60" />
            </>
          )}
        </div>
        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => handleFiles(e.target.files)}
        />
      </div>

      {urls.length > 0 && (
        <p className="text-[10px] text-fg-muted mt-2">
          {urls.length} screenshot{urls.length === 1 ? "" : "s"} saved. These
          are available as references when generating in any workflow under
          this brand.
        </p>
      )}
    </div>
  );
}
