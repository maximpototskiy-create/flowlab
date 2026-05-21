// src/components/StopPropagation.tsx
"use client";

export default function StopPropagation({ children }: { children: React.ReactNode }) {
  return (
    <div
      onClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
      }}
    >
      {children}
    </div>
  );
}
