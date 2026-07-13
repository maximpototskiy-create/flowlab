"use client";

import { useEffect, useRef } from "react";
import { X, Download, ChevronLeft, ChevronRight, Maximize2 } from "lucide-react";

// ─────────────────────────────────────────────────────────────────────────────
// Lightbox — fullscreen viewer for an image or video URL. Triggered by
// clicking the small "expand" icon on a result thumbnail, or by clicking
// the result preview itself in the expanded node view.
//
// Behaviour:
//   • Click outside, Escape, or X button closes.
//   • Click on media itself does NOT close (so you can zoom-pan natively).
//   • Download button is a simple anchor with `download` attr — relies on
//     the asset URL allowing CORS download. Supabase signed URLs do.
//   • ←/→ keys + on-screen chevrons navigate when onPrev/onNext provided.
// ─────────────────────────────────────────────────────────────────────────────

// Save a remote asset with a real download (Save-As dialog if the browser is
// set to ask). A plain <a download> is ignored for cross-origin URLs - the
// browser just opened the image in a new tab (the "long download path"
// complaint). Falls back to opening the URL if CORS blocks the fetch.
export async function downloadAsset(src: string, filename?: string) {
  try {
    const r = await fetch(src, { mode: "cors" });
    if (!r.ok) throw new Error(String(r.status));
    const b = await r.blob();
    const u = URL.createObjectURL(b);
    const a = document.createElement("a");
    a.href = u;
    a.download = filename || (src.split("/").pop() ?? "asset").split("?")[0] || "asset";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(u), 5000);
  } catch {
    window.open(src, "_blank", "noopener,noreferrer");
  }
}

export default function Lightbox({
  src,
  kind,
  onClose,
  onPrev,
  onNext,
  position,
}: {
  src: string;
  kind: "image" | "video";
  onClose: () => void;
  /** Show a left arrow + bind ← key when there's a previous item. */
  onPrev?: () => void;
  /** Show a right arrow + bind → key when there's a next item. */
  onNext?: () => void;
  /** Optional "3 of 4" badge at the bottom when navigating a list. */
  position?: { current: number; total: number };
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft" && onPrev) onPrev();
      else if (e.key === "ArrowRight" && onNext) onNext();
    }
    document.addEventListener("keydown", onKey);
    // Lock body scroll while lightbox is open.
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose, onPrev, onNext]);

  // Fullscreen is requested on the STABLE ROOT overlay, not the media element:
  // prev/next remounts the <img>/<video> (and swaps tags between kinds), and
  // fullscreening a node that then leaves the DOM makes the browser exit
  // fullscreen - the "arrows kick me out of fullscreen" bug. The root never
  // remounts, so navigation keeps fullscreen; arrows/toolbar stay usable too.
  const rootRef = useRef<HTMLDivElement | null>(null);
  const goFullscreen = () => {
    const el = rootRef.current as (HTMLDivElement & { webkitRequestFullscreen?: () => void }) | null;
    if (!el) return;
    try {
      if (document.fullscreenElement) { void document.exitFullscreen?.(); return; }
      if (el.requestFullscreen) void el.requestFullscreen();
      else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
    } catch { /* ignore */ }
  };

  // Generate a sensible download filename from the URL path.
  const filename = (() => {
    try {
      const u = new URL(src);
      const base = u.pathname.split("/").pop() ?? "asset";
      // Strip query suffix if present
      return base.split("?")[0] || "asset";
    } catch {
      return kind === "image" ? "image.png" : "video.mp4";
    }
  })();

  return (
    <div
      ref={rootRef}
      className="fixed inset-0 z-[9999] bg-black/90 flex items-center justify-center p-2"
      onClick={onClose}
    >
      {/* Controls — one compact rounded toolbar at the top-right. It carries its
          own solid contrast, so it reads cleanly over media of ANY size/shape
          (no full-width gradient band stretching across the empty letterbox). */}
      <div
        className="absolute top-3 right-3 flex items-center gap-0.5 bg-black/55 backdrop-blur rounded-full p-1 z-20"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={goFullscreen}
          className="flex items-center gap-1.5 pl-3 pr-3.5 py-1.5 rounded-full hover:bg-white/15 text-white text-[12px]"
          title="True fullscreen"
        >
          <Maximize2 size={14} />
          <span className="hidden sm:inline">Fullscreen</span>
        </button>
        <button
          type="button"
          onClick={() => void downloadAsset(src, filename)}
          className="flex items-center gap-1.5 pl-3 pr-3.5 py-1.5 rounded-full hover:bg-white/15 text-white text-[12px]"
          title="Download to disk"
        >
          <Download size={14} />
          <span className="hidden sm:inline">Download</span>
        </button>
        <button
          type="button"
          onClick={onClose}
          className="w-8 h-8 rounded-full hover:bg-white/15 text-white flex items-center justify-center"
          title="Close (Esc)"
        >
          <X size={18} />
        </button>
      </div>

      {/* Media container — stopPropagation so clicking the media doesn't close */}
      <div
        className="max-w-[98vw] max-h-[97vh] flex items-center justify-center"
        onClick={(e) => e.stopPropagation()}
      >
        {kind === "image" ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={src}
            alt=""
            className="max-w-full max-h-[97vh] object-contain rounded"
          />
        ) : (
          <video
            src={src}
            controls
            autoPlay
            className="max-w-full max-h-[97vh] object-contain rounded"
          />
        )}
      </div>

      {/* Left/right nav arrows — visible only when there's something to go to.
          stopPropagation so clicking the arrow doesn't close lightbox via
          the outer backdrop onClick. */}
      {onPrev && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onPrev();
          }}
          className="absolute left-4 top-1/2 -translate-y-1/2 w-11 h-11 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center backdrop-blur"
          title="Previous (←)"
        >
          <ChevronLeft size={22} />
        </button>
      )}
      {onNext && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onNext();
          }}
          className="absolute right-4 top-1/2 -translate-y-1/2 w-11 h-11 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center backdrop-blur"
          title="Next (→)"
        >
          <ChevronRight size={22} />
        </button>
      )}

      {/* "n of N" badge at the bottom when navigating a list. */}
      {position && position.total > 1 && (
        <div
          className="absolute bottom-4 left-1/2 -translate-x-1/2 px-3 py-1 rounded-full bg-white/10 text-white text-[12px] backdrop-blur"
          onClick={(e) => e.stopPropagation()}
        >
          {position.current + 1} / {position.total}
        </div>
      )}
    </div>
  );
}
