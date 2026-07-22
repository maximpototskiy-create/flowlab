"use client";

// Editor-scoped error boundary: a runtime error inside the editor shows a
// recover screen instead of nuking the whole page (and unsaved context).
export default function EditorError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="min-h-screen bg-bg flex items-center justify-center p-8">
      <div className="max-w-md text-center space-y-4">
        <div className="text-[11px] uppercase tracking-wider text-red-400">Editor error</div>
        <p className="text-fg text-sm leading-relaxed break-words">
          {error.message || "Something went wrong in the editor."}
        </p>
        {error.digest && <p className="text-fg-subtle text-[10px]">digest: {error.digest}</p>}
        <button
          onClick={reset}
          className="px-4 py-2 rounded-md bg-brand text-black text-[12px] font-medium hover:opacity-90 transition"
        >
          Reload editor
        </button>
      </div>
    </div>
  );
}
