"use client";

import { Moon, Sun } from "lucide-react";
import { useTheme } from "./ThemeProvider";

export default function ThemeToggle() {
  const { theme, toggle } = useTheme();
  return (
    <button
      onClick={toggle}
      className="w-8 h-8 flex items-center justify-center rounded-lg border border-[rgb(var(--hairline)/var(--hairline-alpha))] hover:bg-bg-hover text-fg-muted hover:text-fg transition"
      title={theme === "light" ? "Switch to dark" : "Switch to light"}
      aria-label="Toggle theme"
    >
      {theme === "light" ? <Moon size={14} strokeWidth={1.5} /> : <Sun size={14} strokeWidth={1.5} />}
    </button>
  );
}
