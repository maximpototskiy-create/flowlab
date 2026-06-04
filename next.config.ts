import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep heavy Node-only deps out of the webpack bundle; resolve at runtime.
  serverExternalPackages: ["googleapis", "sharp"],
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
