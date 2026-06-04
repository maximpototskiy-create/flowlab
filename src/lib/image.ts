// Marengo accepts only JPEG/PNG images. WebP, GIF, HEIC, etc. must be
// converted first. We re-host the converted JPEG in our own storage and embed
// it by URL (the URL path is what Marengo reliably accepts).
import sharp from "sharp";
import { uploadBytes } from "@/lib/storage";

// Returns a URL that Marengo can embed. Rules:
//  • our Supabase JPEG/PNG → used as-is (Marengo accepts our URLs);
//  • anything else (external host like App Store mzstatic, or webp/gif/heic…)
//    → downloaded, converted to JPEG, re-hosted in our storage, that URL used.
// External URLs are always re-hosted because Marengo rejects many of them
// ("parameters are invalid: url") even when the format is fine.
export async function ensureEmbeddableImage(url: string, jpegStoragePath: string): Promise<string> {
  const isOurs = /\.supabase\.co/i.test(url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch image ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());

  let format: string | undefined;
  try {
    format = (await sharp(buf).metadata()).format;
  } catch {
    format = undefined;
  }
  const okFormat = format === "jpeg" || format === "jpg" || format === "png";

  // Our own JPEG/PNG can be embedded directly.
  if (isOurs && okFormat) return url;

  // Otherwise re-host as JPEG in our storage and embed that URL.
  const jpeg = await sharp(buf).flatten({ background: "#ffffff" }).jpeg({ quality: 90 }).toBuffer();
  const { cdnUrl } = await uploadBytes(jpeg, jpegStoragePath, "image/jpeg");
  return cdnUrl;
}
