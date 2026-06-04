// Marengo accepts only JPEG/PNG images. WebP, GIF, HEIC, etc. must be
// converted first. We re-host the converted JPEG in our own storage and embed
// it by URL (the URL path is what Marengo reliably accepts).
import sharp from "sharp";
import { uploadBytes } from "@/lib/storage";

// Returns a URL that Marengo can embed: the original if it's already JPEG/PNG,
// otherwise a freshly converted JPEG uploaded to `jpegStoragePath`.
export async function ensureEmbeddableImage(url: string, jpegStoragePath: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch image ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());

  let format: string | undefined;
  try {
    format = (await sharp(buf).metadata()).format;
  } catch {
    format = undefined;
  }
  if (format === "jpeg" || format === "jpg" || format === "png") return url;

  // Convert anything else to JPEG (flatten drops alpha onto white).
  const jpeg = await sharp(buf).flatten({ background: "#ffffff" }).jpeg({ quality: 90 }).toBuffer();
  const { cdnUrl } = await uploadBytes(jpeg, jpegStoragePath, "image/jpeg");
  return cdnUrl;
}
