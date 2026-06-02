"use client";

import { useEffect, useRef } from "react";

// Floating help panel listing canvas shortcuts & gestures. Opened from the
// "?" button in the toolbar. Purely informational.

// Detect platform so we show Ctrl on Windows/Linux and ⌘ on macOS — most of
// the team is on Windows.
const IS_MAC =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = IS_MAC ? "⌘" : "Ctrl";
const ALT = IS_MAC ? "⌥" : "Alt";

const SHORTCUTS: { keys: string; desc: string }[] = [
  { keys: `Shift / ${MOD} + click`, desc: "Add node to selection" },
  { keys: "Drag empty area", desc: "Marquee select" },
  { keys: `${MOD} A`, desc: "Select all" },
  { keys: "Delete / Backspace", desc: "Delete selected" },
  { keys: `${MOD} G`, desc: "Group selection" },
  { keys: `${MOD} Shift G`, desc: "Ungroup" },
  { keys: `${MOD} C / ${MOD} V`, desc: "Copy / paste node" },
  { keys: `${MOD} D`, desc: "Duplicate node" },
  { keys: `${MOD} Enter`, desc: "Run selected node" },
  { keys: "Esc", desc: "Clear selection / close menus" },
];
const GESTURES: { keys: string; desc: string }[] = [
  { keys: `Space / ${ALT} / middle-drag`, desc: "Pan canvas" },
  { keys: `${MOD} + scroll`, desc: "Zoom" },
  { keys: "Right-click node", desc: "Node actions menu" },
  { keys: "Right-click group", desc: "Group actions menu" },
  { keys: "Right-click field", desc: "Native copy / paste" },
  { keys: "Drag group frame", desc: "Move whole group" },
  { keys: "Click group label", desc: "Rename group" },
];

export default function HelpHints({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function onDown(e: MouseEvent) {
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

  const Section = ({ title, rows }: { title: string; rows: { keys: string; desc: string }[] }) => (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-fg-subtle font-medium mb-1.5">{title}</div>
      <div className="space-y-1">
        {rows.map((r) => (
          <div key={r.keys} className="flex items-center justify-between gap-3 text-[12px]">
            <span className="text-fg-muted">{r.desc}</span>
            <kbd className="px-1.5 py-0.5 rounded bg-bg-subtle border border-border text-[10px] text-fg whitespace-nowrap">
              {r.keys}
            </kbd>
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <div
      ref={ref}
      className="absolute bottom-16 left-1/2 z-30 w-[340px] -ml-[170px] rounded-xl bg-bg-card border border-border shadow-panel p-4"
    >
      <div className="flex items-center justify-between mb-3">
        <span className="text-[13px] font-semibold text-fg">Canvas shortcuts</span>
        <button onClick={onClose} className="text-fg-subtle hover:text-fg text-[11px]">
          Esc
        </button>
      </div>
      <div className="grid grid-cols-1 gap-4">
        <Section title="Selection & nodes" rows={SHORTCUTS} />
        <Section title="Navigation & menus" rows={GESTURES} />
      </div>
    </div>
  );
}
