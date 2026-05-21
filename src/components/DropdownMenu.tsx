// src/components/DropdownMenu.tsx
"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export type DropdownItem = {
  label: string;
  onClick: () => void;
  danger?: boolean;
};

export default function DropdownMenu({
  trigger,
  items,
  align = "right",
}: {
  trigger: React.ReactNode;
  items: DropdownItem[];
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [mounted, setMounted] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      const t = e.target as HTMLElement;
      if (!t.closest("[data-dropdown-menu]") && !triggerRef.current?.contains(t)) {
        setOpen(false);
      }
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  function toggle(e: React.MouseEvent) {
    e.stopPropagation();
    e.preventDefault();
    if (!open && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      const menuWidth = 180;
      setPos({
        top: rect.bottom + 4,
        left:
          align === "right"
            ? rect.right - menuWidth
            : rect.left,
      });
    }
    setOpen(!open);
  }

  return (
    <>
      <button
        ref={triggerRef}
        onClick={toggle}
        className="w-7 h-7 flex items-center justify-center text-fg-muted hover:text-fg hover:bg-bg-hover rounded-sm transition"
        aria-label="More actions"
      >
        {trigger}
      </button>
      {open &&
        mounted &&
        pos &&
        createPortal(
          <div
            data-dropdown-menu
            className="fixed z-[999] bg-bg-subtle border border-border-strong rounded-sm shadow-xl min-w-[180px] py-1 animate-fade-up"
            style={{ top: pos.top, left: pos.left }}
            onClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
          >
            {items.map((item, i) => (
              <button
                key={i}
                onClick={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  setOpen(false);
                  item.onClick();
                }}
                className={`w-full text-left px-3 py-2 text-sm transition ${
                  item.danger
                    ? "text-red-400 hover:bg-red-500/10"
                    : "text-fg hover:bg-bg-hover"
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>,
          document.body
        )}
    </>
  );
}
