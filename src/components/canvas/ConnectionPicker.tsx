"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { NODE_TYPES, CATEGORY_COLORS, type PortKind, portsCompatible } from "@/lib/canvas/types";
import { NodeIcon } from "@/lib/canvas/icons";

export default function ConnectionPicker({
  x, y, sourceKind, onPick, onClose,
}: {
  x: number; y: number; sourceKind: PortKind;
  onPick: (type: string, inputPort: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    function onDown(e: MouseEvent) {
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

  // Find node types with an input that accepts `sourceKind`
  const candidates: { id: string; def: typeof NODE_TYPES[string]; inputPort: string }[] = [];
  for (const [id, def] of Object.entries(NODE_TYPES)) {
    if (def.inputs.length === 0) continue;
    for (const p of def.inputs) {
      if (portsCompatible(sourceKind, p.type)) {
        const q = query.toLowerCase();
        if (!q || def.name.toLowerCase().includes(q)) {
          candidates.push({ id, def, inputPort: p.name });
          break;
        }
      }
    }
  }

  const W = 280, H = 420;
  const left = Math.min(x, (typeof window !== "undefined" ? window.innerWidth : 1000) - W - 12);
  const top = Math.min(y, (typeof window !== "undefined" ? window.innerHeight : 800) - H - 12);

  return createPortal(
    <div
      ref={ref}
      className="fixed z-[900] glass r-lg overflow-hidden flex flex-col animate-fade-up"
      style={{ left, top, width: W, maxHeight: H }}
    >
      <div className="px-3 py-2 border-b border-border">
        <div className="text-[10px] uppercase tracking-wider text-fg-subtle font-semibold">
          Connect to…
        </div>
        <input
          autoFocus
          type="text"
          placeholder="Filter…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="w-full mt-1 px-2.5 py-1.5 rounded-md bg-bg-subtle/60 border border-border outline-none focus:border-brand text-[12px] text-fg placeholder:text-fg-subtle"
        />
      </div>
      <div className="flex-1 overflow-y-auto py-1">
        {candidates.map(({ id, def, inputPort }) => (
          <button
            key={id}
            onMouseDown={(e) => {
              // Use mousedown (not click) + stopPropagation so this fires
              // BEFORE the global outside-click-close listener.
              e.preventDefault();
              e.stopPropagation();
              onPick(id, inputPort);
              onClose();
            }}
            className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-bg-hover text-left text-fg-muted hover:text-fg"
          >
            <NodeIcon name={def.icon} size={12} style={{ color: CATEGORY_COLORS[def.category] }} />
            <span className="text-[11.5px]">{def.name}</span>
          </button>
        ))}
        {candidates.length === 0 && (
          <div className="px-4 py-4 text-[11px] text-fg-subtle italic">No compatible nodes</div>
        )}
      </div>
    </div>,
    document.body,
  );
}
