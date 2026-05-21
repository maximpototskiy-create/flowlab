"use client";

import { createContext, useContext, useEffect, useState } from "react";

type Theme = "light" | "dark";
type Ctx = { theme: Theme; setTheme: (t: Theme) => void; toggle: () => void };

const ThemeCtx = createContext<Ctx | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // Default light to match the brief; persisted in localStorage
  const [theme, setThemeState] = useState<Theme>("light");

  // Boot: read localStorage + apply
  useEffect(() => {
    const stored = localStorage.getItem("flowlab-theme") as Theme | null;
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const initial: Theme = stored ?? (prefersDark ? "dark" : "light");
    applyTheme(initial);
    setThemeState(initial);
  }, []);

  function applyTheme(t: Theme) {
    document.documentElement.classList.toggle("dark", t === "dark");
    document.documentElement.style.colorScheme = t;
  }

  function setTheme(t: Theme) {
    applyTheme(t);
    localStorage.setItem("flowlab-theme", t);
    setThemeState(t);
  }

  function toggle() {
    setTheme(theme === "light" ? "dark" : "light");
  }

  return <ThemeCtx.Provider value={{ theme, setTheme, toggle }}>{children}</ThemeCtx.Provider>;
}

export function useTheme() {
  const v = useContext(ThemeCtx);
  if (!v) return { theme: "light" as Theme, setTheme: () => {}, toggle: () => {} };
  return v;
}
