import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { ThemeProvider } from "@/components/ThemeProvider";

// Cross-platform Apple-like typography: real SF on Apple devices (via -apple-system
// in globals.css), Inter everywhere else. Self-hosted by next/font (no runtime
// Google dependency), exposed as the --font-inter CSS variable.
const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });

export const metadata: Metadata = {
  title: "FlowLab — Node-based AI workflows for motion teams",
  description: "Build, share and run AI generation pipelines.",
};

// Inline theme bootstrap — runs before React hydrates to prevent flash
const themeBootstrap = `
(function() {
  try {
    var t = localStorage.getItem('flowlab-theme');
    if (!t) t = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    if (t === 'dark') document.documentElement.classList.add('dark');
    document.documentElement.style.colorScheme = t;
  } catch(e) {}
})();
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
      </head>
      <body className="min-h-screen antialiased">
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
