"use client";

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

export type ActionItem = {
  label: string;
  icon?: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
  /** Render a divider ABOVE this item. */
  separator?: boolean;
};

// A lightweight right-click action menu (distinct from the node-picker).
// Used for per-node and per-group context menus.
export default function ActionMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: ActionItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

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

  const W = 200;
  const H = items.length * 34 + 8;
  const left = Math.min(x, (typeof window !== "undefined" ? window.innerWidth : 1000) - W - 12);
  const top = Math.min(y, (typeof window !== "undefined" ? window.innerHeight : 800) - H - 12);

  return createPortal(
    <div
      ref={ref}
      className="fixed z-[900] bg-bg-card border border-border rounded-lg shadow-panel overflow-hidden py-1 animate-fade-up"
      style={{ left, top, width: W }}
    >
      {items.map((it, i) => (
        <div key={i}>
          {it.separator && <div className="h-px bg-border my-1" />}
          <button
            // Stop the mousedown from bubbling to the document outside-click
            // handler, which would otherwise close the menu BEFORE the click
            // fires — making every item look dead until a page refresh.
            onMouseDown={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              it.onClick();
              onClose();
            }}
            className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-[12px] text-left hover:bg-bg-hover ${
              it.danger ? "text-rose-500" : "text-fg"
            }`}
          >
            {it.icon && <span className="w-4 flex items-center justify-center">{it.icon}</span>}
            {it.label}
          </button>
        </div>
      ))}
    </div>,
    document.body,
  );
}
