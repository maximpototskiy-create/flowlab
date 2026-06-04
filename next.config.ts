import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep heavy Node-only deps out of the webpack bundle; resolve at runtime.
  serverExternalPackages: ["googleapis", "sharp", "ffmpeg-static"],
  // ffmpeg-static ships a binary at a path Next's tracer can't infer, so the
  // file is omitted from the serverless function → "spawn … ffmpeg ENOENT".
  // Force it into the functions that actually run ffmpeg.
  outputFileTracingIncludes: {
    "/api/drive/import": ["./node_modules/ffmpeg-static/**"],
    "/api/brand-assets": ["./node_modules/ffmpeg-static/**"],
    "/api/brand-assets/reembed": ["./node_modules/ffmpeg-static/**"],
  },
  // Images from Supabase Storage and fal.ai CDN
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "**.supabase.co" },
      { protocol: "https", hostname: "**.fal.media" },
      { protocol: "https", hostname: "fal.media" },
      { protocol: "https", hostname: "storage.googleapis.com" },
    ],
  },
};

export default nextConfig;
