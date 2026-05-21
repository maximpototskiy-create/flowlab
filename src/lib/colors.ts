// src/lib/colors.ts
// Project color palette. Maps a stored color name to Tailwind classes.
// Used in ProjectCard and breadcrumb badges.

export const PROJECT_COLORS = {
  emerald: {
    bg: "bg-emerald-500/10",
    text: "text-emerald-400",
    border: "border-emerald-500/30",
    dot: "bg-emerald-400",
    hex: "#10b981",
  },
  amber: {
    bg: "bg-amber-500/10",
    text: "text-amber-400",
    border: "border-amber-500/30",
    dot: "bg-amber-400",
    hex: "#f59e0b",
  },
  rose: {
    bg: "bg-rose-500/10",
    text: "text-rose-400",
    border: "border-rose-500/30",
    dot: "bg-rose-400",
    hex: "#f43f5e",
  },
  blue: {
    bg: "bg-blue-500/10",
    text: "text-blue-400",
    border: "border-blue-500/30",
    dot: "bg-blue-400",
    hex: "#3b82f6",
  },
  violet: {
    bg: "bg-violet-500/10",
    text: "text-violet-400",
    border: "border-violet-500/30",
    dot: "bg-violet-400",
    hex: "#8b5cf6",
  },
  sky: {
    bg: "bg-sky-500/10",
    text: "text-sky-400",
    border: "border-sky-500/30",
    dot: "bg-sky-400",
    hex: "#0ea5e9",
  },
  zinc: {
    bg: "bg-zinc-500/10",
    text: "text-zinc-300",
    border: "border-zinc-500/30",
    dot: "bg-zinc-400",
    hex: "#71717a",
  },
} as const;

export type ProjectColor = keyof typeof PROJECT_COLORS;

export function getColor(name?: string | null) {
  if (name && name in PROJECT_COLORS) {
    return PROJECT_COLORS[name as ProjectColor];
  }
  return PROJECT_COLORS.emerald;
}
