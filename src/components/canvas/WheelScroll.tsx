"use client";

import { useEffect, useRef } from "react";

/**
 * A scrollable container that keeps the mouse wheel from reaching the canvas.
 *
 * The canvas binds a NATIVE (non-delegated) wheel listener on its own element
 * for zoom/pan, which fires regardless of React's synthetic onWheel. So inside
 * node lists (avatar grids, asset pickers) the wheel would scroll the whole
 * canvas instead of the list. We attach a native wheel listener here and
 * stopPropagation so the event never bubbles to the canvas — the element's own
 * overflow scrolling still works as normal.
 */
export function WheelScroll({
  className,
  style,
  children,
  onScroll,
}: {
  className?: string;
  style?: React.CSSProperties;
  children: React.ReactNode;
  onScroll?: React.UIEventHandler<HTMLDivElement>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const stop = (e: WheelEvent) => e.stopPropagation();
    el.addEventListener("wheel", stop, { passive: true });
    return () => el.removeEventListener("wheel", stop);
  }, []);
  return (
    <div ref={ref} className={className} style={style} onScroll={onScroll} onPointerDown={(e) => e.stopPropagation()}>
      {children}
    </div>
  );
}
