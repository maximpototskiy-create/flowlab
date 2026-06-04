// Marengo accepts only JPEG/PNG images. WebP, GIF, HEIC, etc. must be
// converted first. We re-host the converted JPEG in our own storage and embed
// it by URL (the URL path is what Marengo reliably accepts).
import sharp from "sharp";
import { uploadBytes } from "@/lib/storage";

// Returns a URL that Marengo can embed. We always normalize the image and
// re-host it in our storage as JPEG: resized to a safe max dimension (2048px),
// alpha flattened. This avoids every known cause of "parameters are invalid:
// url" — oversized resolution, large files, unsupported formats (webp/gif/…),
// and external hosts (App Store mzstatic) that Marengo refuses to fetch.
export async function ensureEmbeddableImage(url: string, jpegStoragePath: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch image ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());

  const jpeg = await sharp(buf)
    .rotate() // honor EXIF orientation
    .resize({ width: 2048, height: 2048, fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: 88 })
    .toBuffer();

  const { cdnUrl } = await uploadBytes(jpeg, jpegStoragePath, "image/jpeg");
  return cdnUrl;
}
