"use client";

import { useRef, useState } from "react";
import { Upload, X, Expand } from "lucide-react";

export default function UploadZone({
  kind,
  currentUrl,
  onUpload,
  onClear,
  onUrl,
  onExpand,
}: {
  kind: "image" | "video" | "audio";
  currentUrl: string;
  onUpload: (file: File, onProgress?: (pct: number) => void) => Promise<void>;
  onClear: () => void;
  onUrl?: (url: string) => void;
  /** Open this asset in a fullscreen Lightbox. If omitted, no Expand button
   *  is rendered. Useful for uploads where the user wants to inspect the
   *  uploaded image/video at full resolution before running downstream. */
  onExpand?: () => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const accept = { image: "image/*", video: "video/*", audio: "audio/*" }[kind];
  const extLabel = { image: "JPG, PNG, WebP", video: "MP4, WebM, MOV", audio: "MP3, WAV, M4A" }[kind];

  async function handleFile(file: File) {
    setError(null);
    // Files now upload DIRECTLY to Supabase (signed URL) so the old ~4.5MB
    // serverless limit is gone. We still cap at the bucket's 200MB ceiling
    // (also matches Kling O3 v2v's max source-video size) to fail fast with
    // a clear message rather than after a long upload.
    const MAX_MB = 200;
    if (file.size > MAX_MB * 1024 * 1024) {
      setError(
        `File is ${(file.size / 1024 / 1024).toFixed(1)}MB — over the ${MAX_MB}MB limit. ` +
          `Compress the ${kind} or paste a hosted URL below.`,
      );
      return;
    }
    setUploading(true);
    setProgress(0);
    try {
      await onUpload(file, (pct) => setProgress(pct));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
      setProgress(0);
    }
  }

  if (currentUrl) {
    return (
      <div className="relative rounded-md overflow-hidden group/upload">
        {kind === "image" ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={currentUrl} alt="" className="w-full max-h-40 object-cover" />
        ) : kind === "video" ? (
          <video src={currentUrl} className="w-full max-h-40" muted loop autoPlay playsInline />
        ) : (
          <audio src={currentUrl} controls className="w-full" />
        )}
        {/* Expand button — only for image/video, and only when caller provides
            an onExpand handler. Sits to the left of the delete X. */}
        {onExpand && kind !== "audio" && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onExpand();
            }}
            onMouseDown={(e) => e.stopPropagation()}
            className="absolute top-1 right-9 w-6 h-6 rounded-full bg-black/60 text-white flex items-center justify-center hover:bg-black/80 opacity-0 group-hover/upload:opacity-100 transition-opacity"
            title="View fullscreen"
          >
            <Expand size={11} />
          </button>
        )}
        <button
          onClick={(e) => {
            e.stopPropagation();
            onClear();
          }}
          onMouseDown={(e) => e.stopPropagation()}
          className="absolute top-1 right-1 w-6 h-6 rounded-full bg-black/60 text-white flex items-center justify-center hover:bg-red-500"
        >
          <X size={12} />
        </button>
      </div>
    );
  }

  return (
    <div onMouseDown={(e) => e.stopPropagation()}>
      <input
        ref={fileInput}
        type="file"
        accept={accept}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) handleFile(f);
        }}
      />
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          fileInput.current?.click();
        }}
        onDragEnter={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragOver={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          // CRITICAL: without stopPropagation the drop bubbles to the canvas
          // drop handler, which imports the same file AGAIN as a new upload
          // node - the "node duplicates together with the image" bug.
          e.stopPropagation();
          setDragOver(false);
          const f = e.dataTransfer.files?.[0];
          if (f) handleFile(f);
        }}
        className={`w-full rounded-md border-2 border-dashed py-6 px-3 text-center transition flex flex-col items-center gap-1.5 ${
          dragOver
            ? "border-brand bg-brand/5 text-brand"
            : "border-border hover:border-border-strong text-fg-muted"
        }`}
      >
        {uploading ? (
          <span className="spinner" />
        ) : (
          <Upload size={16} strokeWidth={1.5} />
        )}
        <div className="text-[11px]">
          {uploading ? `Uploading… ${progress}%` : `Drop ${kind} here or click`}
        </div>
        {uploading ? (
          // Progress bar — fills as the file uploads. Falls back to an
          // indeterminate look at 0% (before first progress event fires).
          <div className="w-full mt-1 h-1.5 rounded-full bg-bg-subtle overflow-hidden">
            <div
              className="h-full bg-brand transition-[width] duration-150"
              style={{ width: `${Math.max(3, progress)}%` }}
            />
          </div>
        ) : (
          <div className="text-[9px] text-fg-subtle">{extLabel}</div>
        )}
      </button>
      {error && (
        <div className="mt-1.5 px-2 py-1.5 rounded bg-red-500/10 border border-red-500/30 text-red-600 dark:text-red-400 text-[10px] leading-snug">
          {error}
        </div>
      )}
      {kind !== "image" && onUrl && (
        <input
          type="text"
          placeholder={`or paste a ${kind} URL`}
          className="w-full mt-1.5 bg-bg-subtle border border-border rounded px-2 py-1 text-[11px] text-fg outline-none focus:border-brand"
          onChange={(e) => onUrl(e.target.value)}
          onMouseDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        />
      )}
    </div>
  );
}
