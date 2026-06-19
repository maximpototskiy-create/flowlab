// src/components/Modal.tsx
"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export default function Modal({
  open,
  onClose,
  title,
  description,
  children,
  size = "md",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: React.ReactNode;
  size?: "sm" | "md" | "lg";
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!open) return;

    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKey);
    document.body.style.overflow = "hidden";

    // Focus first input
    setTimeout(() => {
      const firstInput = dialogRef.current?.querySelector<HTMLElement>(
        'input, textarea, select, button[type="submit"]'
      );
      firstInput?.focus();
    }, 50);

    return () => {
      document.removeEventListener("keydown", handleKey);
      document.body.style.overflow = "";
    };
  }, [open, onClose]);

  if (!open || !mounted) return null;

  const sizeClasses = {
    sm: "max-w-sm",
    md: "max-w-md",
    lg: "max-w-xl",
  };

  // Render through portal to <body> — escapes any parent <Link>, overflow:hidden, etc.
  return createPortal(
    <div
      className="fixed inset-0 z-[1000] flex items-center justify-center p-4 animate-fade-in"
      onClick={(e) => {
        // Click on backdrop closes; click on dialog does not
        e.stopPropagation();
        onClose();
      }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="absolute inset-0 bg-black/50 backdrop-blur-md" />
      <div
        ref={dialogRef}
        className={`relative glass r-lg w-full ${sizeClasses[size]} animate-fade-up`}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
      >
        <div className="px-6 pt-6 pb-4 border-b border-border">
          <div className="font-mono text-[10px] tracking-[0.2em] uppercase text-fg-muted mb-2">
            FlowLab
          </div>
          <h2 id="modal-title" className="font-display text-2xl leading-tight">
            {title}
          </h2>
          {description && (
            <p className="text-fg-muted text-sm mt-1 leading-relaxed">{description}</p>
          )}
        </div>
        <div className="px-6 py-5">{children}</div>
      </div>
    </div>,
    document.body
  );
}
