"use client";

import { useEffect } from "react";
import { X, Download, ChevronLeft, ChevronRight } from "lucide-react";

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
      className="fixed inset-0 z-[9999] bg-black/85 flex items-center justify-center p-4"
      onClick={onClose}
    >
      {/* Top-right controls */}
      <div className="absolute top-3 right-3 flex items-center gap-2 z-10">
        <a
          href={src}
          download={filename}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="flex items-center gap-1 px-2.5 py-1.5 rounded-md bg-white/10 hover:bg-white/20 text-white text-[12px] backdrop-blur"
          title="Download"
        >
          <Download size={14} />
          <span className="hidden sm:inline">Download</span>
        </a>
        <button
          type="button"
          onClick={onClose}
          className="w-9 h-9 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center backdrop-blur"
          title="Close (Esc)"
        >
          <X size={18} />
        </button>
      </div>

      {/* Media container — stopPropagation so clicking the media doesn't close */}
      <div
        className="max-w-[95vw] max-h-[95vh] flex items-center justify-center"
        onClick={(e) => e.stopPropagation()}
      >
        {kind === "image" ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={src}
            alt=""
            className="max-w-full max-h-[95vh] object-contain rounded"
          />
        ) : (
          <video
            src={src}
            controls
            autoPlay
            className="max-w-full max-h-[95vh] rounded"
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
