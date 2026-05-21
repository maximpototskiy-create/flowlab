import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', '"SF Pro Text"', '"SF Pro Display"', '"Segoe UI"', 'system-ui', 'sans-serif'],
        mono: ['ui-monospace', '"SF Mono"', 'Menlo', 'Monaco', 'monospace'],
        display: ['"SF Pro Display"', '-apple-system', 'BlinkMacSystemFont', 'system-ui', 'sans-serif'],
        serif: ['"Source Serif Pro"', 'Georgia', 'serif'],
      },
      colors: {
        // Semantic tokens — driven by CSS variables (theme-aware)
        bg: {
          DEFAULT: "rgb(var(--bg) / <alpha-value>)",
          subtle: "rgb(var(--bg-subtle) / <alpha-value>)",
          card: "rgb(var(--bg-card) / <alpha-value>)",
          input: "rgb(var(--bg-input) / <alpha-value>)",
          hover: "rgb(var(--bg-hover) / <alpha-value>)",
        },
        fg: {
          DEFAULT: "rgb(var(--fg) / <alpha-value>)",
          muted: "rgb(var(--fg-muted) / <alpha-value>)",
          subtle: "rgb(var(--fg-subtle) / <alpha-value>)",
        },
        border: {
          DEFAULT: "rgb(var(--border) / <alpha-value>)",
          strong: "rgb(var(--border-strong) / <alpha-value>)",
        },
        brand: {
          DEFAULT: "rgb(var(--brand) / <alpha-value>)",
          fg: "rgb(var(--brand-fg) / <alpha-value>)",
        },
        // Category colors (also CSS vars but static)
        cat: {
          text: "#3b82f6",
          image: "#10b981",
          video: "#ec4899",
          audio: "#f97316",
          structural: "#8b5cf6",
          output: "#0ea5e9",
          integration: "#a855f7",
          tools: "#facc15",
        },
      },
      borderRadius: { sm: "4px", md: "8px", lg: "12px", xl: "16px" },
      boxShadow: {
        node: "0 1px 2px rgba(0,0,0,0.04), 0 4px 12px rgba(0,0,0,0.06)",
        "node-dark": "0 4px 16px rgba(0,0,0,0.5)",
        panel: "0 10px 40px rgba(0,0,0,0.12)",
      },
      keyframes: {
        spin: { to: { transform: "rotate(360deg)" } },
        pulse: { "50%": { opacity: "0.35" } },
        "fade-in": { from: { opacity: "0" }, to: { opacity: "1" } },
        "fade-up": { from: { opacity: "0", transform: "translateY(4px)" }, to: { opacity: "1", transform: "translateY(0)" } },
        shimmer: { "0%": { transform: "translateX(-100%)" }, "100%": { transform: "translateX(100%)" } },
      },
      animation: {
        spin: "spin 0.8s linear infinite",
        pulse: "pulse 1s infinite",
        "fade-in": "fade-in 0.15s ease-out",
        "fade-up": "fade-up 0.18s ease-out",
        shimmer: "shimmer 1.6s linear infinite",
      },
    },
  },
};
export default config;
