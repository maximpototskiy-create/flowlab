// Supabase Storage helpers.
// Bucket: flowlab-assets (auto-created in setup)
// Storage path: <brandId>/<projectId>/<workflowId>/<runStepId>/<filename>

import { createClient as createServerClient } from "@supabase/supabase-js";

export const BUCKET = "flowlab-assets";

function adminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  if (!url || !key) throw new Error("SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing");
  return createServerClient(url, key, { auth: { persistSession: false } });
}

/** Ensure bucket exists (idempotent). Called on server startup / first asset upload. */
export async function ensureBucket() {
  const supa = adminClient();
  // 200MB — Kling O3 video-to-video accepts source videos up to 200MB.
  // The bucket was originally created at 100MB; bump it if it already
  // exists so big uploads don't get rejected by the storage layer.
  const LIMIT = 1024 * 1024 * 200;
  const { data: buckets } = await supa.storage.listBuckets();
  const existing = buckets?.some((b) => b.name === BUCKET);
  if (existing) {
    await supa.storage.updateBucket(BUCKET, { public: false, fileSizeLimit: LIMIT });
    return;
  }
  await supa.storage.createBucket(BUCKET, { public: false, fileSizeLimit: LIMIT });
}

/** Create a one-time signed UPLOAD url so the browser can PUT a file
 *  DIRECTLY into Supabase Storage, bypassing our serverless route (and its
 *  ~4.5MB request-body limit). Server uses the service-role key to authorise;
 *  the returned token is single-use and scoped to exactly `storagePath`.
 *  The client uploads via supabase.storage.from(BUCKET).uploadToSignedUrl(). */
export async function createUploadUrl(
  storagePath: string,
): Promise<{ path: string; token: string; signedUrl: string }> {
  await ensureBucket();
  const supa = adminClient();
  const { data, error } = await supa.storage
    .from(BUCKET)
    .createSignedUploadUrl(storagePath);
  if (error || !data) {
    throw new Error(`createSignedUploadUrl failed: ${error?.message ?? "no data"}`);
  }
  return { path: storagePath, token: data.token, signedUrl: data.signedUrl };
}

/** Upload a remote URL's content to storage and return path. */
export async function uploadFromUrl(
  remoteUrl: string,
  storagePath: string,
  contentType?: string,
): Promise<{ storagePath: string; cdnUrl: string; sizeBytes: number }> {
  await ensureBucket();
  const supa = adminClient();

  const res = await fetch(remoteUrl);
  if (!res.ok) throw new Error(`Failed to fetch ${remoteUrl}: ${res.status}`);
  const buf = await res.arrayBuffer();
  const mime = contentType ?? res.headers.get("content-type") ?? guessMime(remoteUrl);

  const { error } = await supa.storage.from(BUCKET).upload(storagePath, buf, {
    contentType: mime,
    upsert: true,
  });
  if (error) throw new Error(`Storage upload failed: ${error.message}`);

  // Use signed URL — private bucket
  const { data: signed } = await supa.storage.from(BUCKET).createSignedUrl(storagePath, 60 * 60 * 24 * 30);
  return {
    storagePath,
    cdnUrl: signed?.signedUrl ?? "",
    sizeBytes: buf.byteLength,
  };
}

/** Upload raw bytes (e.g., from user file upload) */
export async function uploadBytes(
  bytes: ArrayBuffer | Uint8Array | Buffer,
  storagePath: string,
  contentType: string,
): Promise<{ storagePath: string; cdnUrl: string; sizeBytes: number }> {
  await ensureBucket();
  const supa = adminClient();

  const { error } = await supa.storage.from(BUCKET).upload(storagePath, bytes as Buffer, {
    contentType,
    upsert: true,
  });
  if (error) throw new Error(`Storage upload failed: ${error.message}`);

  const { data: signed } = await supa.storage.from(BUCKET).createSignedUrl(storagePath, 60 * 60 * 24 * 30);
  return {
    storagePath,
    cdnUrl: signed?.signedUrl ?? "",
    sizeBytes: (bytes as ArrayBuffer).byteLength ?? (bytes as Buffer).length,
  };
}

/** Get fresh signed URL for an existing object */
export async function refreshSignedUrl(storagePath: string, ttlSec = 60 * 60 * 24 * 30): Promise<string> {
  const supa = adminClient();
  const { data, error } = await supa.storage.from(BUCKET).createSignedUrl(storagePath, ttlSec);
  if (error) throw new Error(error.message);
  return data?.signedUrl ?? "";
}

export function buildStoragePath(parts: {
  brandId?: string | null;
  projectId?: string | null;
  workflowId?: string | null;
  runStepId?: string;
  ext: string;
  prefix?: string;
}): string {
  const segments = [
    parts.brandId ?? "global",
    parts.projectId ?? "no-project",
    parts.workflowId ?? "no-workflow",
    parts.runStepId ?? `manual-${Date.now()}`,
  ];
  const filename = `${parts.prefix ?? "asset"}-${Math.random().toString(36).slice(2, 8)}.${parts.ext}`;
  return [...segments, filename].join("/");
}

function guessMime(url: string): string {
  const ext = url.split(".").pop()?.toLowerCase().split("?")[0] ?? "";
  const map: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    gif: "image/gif",
    mp4: "video/mp4",
    webm: "video/webm",
    mov: "video/quicktime",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    m4a: "audio/mp4",
    ogg: "audio/ogg",
  };
  return map[ext] ?? "application/octet-stream";
}

export function extFromUrl(url: string): string {
  return url.split(".").pop()?.toLowerCase().split("?")[0] ?? "bin";
}

export function kindFromMime(mime: string): "image" | "video" | "audio" | "text" {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return "text";
}
