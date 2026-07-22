"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Search } from "lucide-react";
import {
  NODE_TYPES, CATEGORY_LABELS, CATEGORY_DESC, CATEGORY_ORDER, CATEGORY_COLORS,
  QUICK_ACTIONS,
} from "@/lib/canvas/types";
import { NodeIcon } from "@/lib/canvas/icons";

export default function ContextMenu({
  x, y, onPick, onClose,
}: {
  x: number; y: number; onPick: (type: string) => void; onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  // Keyboard navigation over search results: ArrowDown/Up move the highlight,
  // Enter inserts - type half a name, arrow, Enter, done (no mouse trip).
  const [hl, setHl] = useState(0);

  useEffect(() => {
    function onDown(e: MouseEvent) {
      // Only close on LEFT-click outside; right-click triggers a new context menu
      if (e.button !== 0) return;
      if (!ref.current?.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    setTimeout(() => document.addEventListener("mousedown", onDown), 50);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const q = query.toLowerCase().trim();
  const matches = q
    ? Object.entries(NODE_TYPES).filter(
        ([, d]) => d.name.toLowerCase().includes(q) || d.description.toLowerCase().includes(q),
      )
    : null;
  const hlSafe = matches && matches.length > 0 ? Math.min(hl, matches.length - 1) : 0;

  // Clamp position to viewport
  const W = 320, H = 540;
  const left = Math.min(x, (typeof window !== "undefined" ? window.innerWidth : 1000) - W - 12);
  const top = Math.min(y, (typeof window !== "undefined" ? window.innerHeight : 800) - H - 12);

  return createPortal(
    <div
      ref={ref}
      className="fixed z-[900] glass r-lg overflow-hidden flex flex-col animate-fade-up"
      style={{ left, top, width: W, maxHeight: H }}
    >
      {/* Search */}
      <div className="px-3 py-2 border-b border-border relative">
        <Search size={12} className="absolute left-5 top-1/2 -translate-y-1/2 text-fg-subtle" strokeWidth={1.5} />
        <input
          autoFocus
          type="text"
          placeholder="Search or pick a node…"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setHl(0); }}
          onKeyDown={(e) => {
            if (!matches || matches.length === 0) return;
            if (e.key === "ArrowDown") { e.preventDefault(); setHl((i) => Math.min(i + 1, matches.length - 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setHl((i) => Math.max(i - 1, 0)); }
            else if (e.key === "Enter") { e.preventDefault(); const m = matches[hlSafe]; if (m) { onPick(m[0]); onClose(); } }
          }}
          className="w-full bg-transparent border-none outline-none pl-5 text-[12px] text-fg placeholder:text-fg-subtle"
        />
      </div>

      <div className="flex-1 overflow-y-auto py-1">
        {matches ? (
          <div>
            {matches.map(([id, def], mi) => (
              <button
                key={id}
                onMouseDown={(e) => {
                  // Use mousedown (not click) so the pick fires BEFORE any other
                  // mousedown listener (like outside-click-close) gets a chance.
                  e.preventDefault();
                  e.stopPropagation();
                  onPick(id);
                  onClose();
                }}
                onMouseEnter={() => setHl(mi)}
                className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-left ${mi === hlSafe ? "bg-bg-hover ring-1 ring-inset ring-brand/40" : "hover:bg-bg-hover"}`}
              >
                <NodeIcon name={def.icon} size={13} style={{ color: CATEGORY_COLORS[def.category] }} />
                <div className="flex-1 min-w-0">
                  <div className="text-[12px] text-fg leading-tight">{def.name}</div>
                  <div className="text-[10px] text-fg-subtle truncate">{def.description}</div>
                </div>
              </button>
            ))}
            {matches.length === 0 && (
              <div className="px-4 py-4 text-[11px] text-fg-subtle italic">No matches</div>
            )}
          </div>
        ) : (
          <>
            {/* Quick row */}
            <div className="px-3 py-2 border-b border-border">
              <div className="text-[9px] uppercase tracking-wider text-fg-subtle font-semibold mb-1.5">
                Generate
              </div>
              <div className="flex flex-wrap gap-1">
                {QUICK_ACTIONS.filter((a) => a.group === "generate").map((a) => (
                  <button
                    key={a.id}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      onPick(a.type);
                      onClose();
                    }}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-bg-subtle border border-border hover:border-border-strong text-[10.5px] text-fg-muted hover:text-fg"
                  >
                    <NodeIcon name={a.icon} size={11} />
                    {a.label}
                  </button>
                ))}
              </div>

              <div className="text-[9px] uppercase tracking-wider text-fg-subtle font-semibold mt-2 mb-1.5">
                Add
              </div>
              <div className="flex flex-wrap gap-1">
                {QUICK_ACTIONS.filter((a) => a.group === "add").map((a) => (
                  <button
                    key={a.id}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      onPick(a.type);
                      onClose();
                    }}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-bg-subtle border border-border hover:border-border-strong text-[10.5px] text-fg-muted hover:text-fg"
                  >
                    <NodeIcon name={a.icon} size={11} />
                    {a.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Categorized list */}
            {CATEGORY_ORDER.map((cat) => {
              const nodes = Object.entries(NODE_TYPES).filter(([, d]) => d.category === cat);
              if (nodes.length === 0) return null;
              return (
                <div key={cat} className="pt-1">
                  <div className="px-3 pt-1.5 pb-1">
                    <div className="text-[11px] font-medium text-fg" style={{ color: CATEGORY_COLORS[cat] }}>
                      {CATEGORY_LABELS[cat]}
                    </div>
                    <div className="text-[10px] text-fg-subtle leading-tight">{CATEGORY_DESC[cat]}</div>
                  </div>
                  {nodes.map(([id, def]) => (
                    <button
                      key={id}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        onPick(id);
                        onClose();
                      }}
                      className="w-full flex items-center gap-2 px-3 py-1 hover:bg-bg-hover text-left text-fg-muted hover:text-fg"
                    >
                      <NodeIcon name={def.icon} size={12} style={{ color: CATEGORY_COLORS[cat] }} />
                      <span className="text-[11.5px]">{def.name}</span>
                    </button>
                  ))}
                </div>
              );
            })}
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
