// Shared Drive→library import logic, used by the manual endpoint and the cron.
// Imports a bounded batch of new files for one brand: Drive → Supabase →
// brand_asset → embed. Dedupe by drive_file_id.
import { prisma } from "@/lib/prisma";
import { findBrandFolder, collectBrandFiles, downloadDriveFile, type DriveFile } from "@/lib/drive/client";
import { uploadBytes } from "@/lib/storage";
import { embedImage, embedAudio } from "@/lib/twelvelabs/embed";
import { embedVideoSmart, convertToMp4 } from "@/lib/video";
import { insertEmbedding } from "@/lib/semantic";
import { ensureEmbeddableImage } from "@/lib/image";

const MAX_BYTES = 200 * 1024 * 1024; // skip files larger than 200 MB for now

export type ImportResult = {
  ok: boolean;
  error?: string;
  totalInDrive?: number;
  newFound?: number;
  imported?: number;
  embeddedImages?: number;
  videos?: number;
  skippedLarge?: number;
  failed?: number;
  embedErrors?: string[];
  remaining?: number;
};

export async function importBrandBatch(brandId: string, maxPerRun: number): Promise<ImportResult> {
  const brand = await prisma.brand.findUnique({ where: { id: brandId } });
  if (!brand) return { ok: false, error: "brand not found" };

  let folderId = (brand as { driveFolderId?: string | null }).driveFolderId ?? null;
  const libraryId = process.env.DRIVE_LIBRARY_FOLDER_ID;
  const resolveByName = async () => (libraryId ? findBrandFolder(libraryId, brand.name) : null);

  if (!folderId) {
    if (!libraryId) return { ok: false, error: "No drive folder set and DRIVE_LIBRARY_FOLDER_ID missing" };
    try {
      folderId = await resolveByName();
    } catch (err) {
      return { ok: false, error: `Drive access failed: ${err instanceof Error ? err.message : err}` };
    }
    if (!folderId) return { ok: false, error: `No Drive folder matching "${brand.name}"` };
    await prisma.brand.update({ where: { id: brandId }, data: { driveFolderId: folderId } });
  }

  let driveFiles: DriveFile[];
  try {
    driveFiles = await collectBrandFiles(folderId);
  } catch (err) {
    try {
      const re = await resolveByName();
      if (re && re !== folderId) {
        folderId = re;
        await prisma.brand.update({ where: { id: brandId }, data: { driveFolderId: folderId } });
        driveFiles = await collectBrandFiles(folderId);
      } else {
        return { ok: false, error: `Drive list failed: ${err instanceof Error ? err.message : err}` };
      }
    } catch (err2) {
      return { ok: false, error: `Drive list failed: ${err2 instanceof Error ? err2.message : err2}` };
    }
  }

  const existing = await prisma.brandAsset.findMany({
    where: { brandId, driveFileId: { not: null } },
    select: { driveFileId: true },
  });
  const have = new Set(existing.map((e: { driveFileId: string | null }) => e.driveFileId));
  const fresh = driveFiles.filter((f) => !have.has(f.id));

  let imported = 0;
  let embeddedImages = 0;
  let videos = 0;
  let skippedLarge = 0;
  let failed = 0;
  const embedErrors: string[] = [];
  const batch = fresh.slice(0, maxPerRun);

  for (const f of batch) {
    if (f.sizeBytes && f.sizeBytes > MAX_BYTES) {
      skippedLarge++;
      continue;
    }
    const kind = f.mimeType.startsWith("video/") ? "video" : f.mimeType.startsWith("audio/") ? "audio" : "image";
    try {
      let bytes = await downloadDriveFile(f.id);
      let safeName = f.name.replace(/[^\w.\-]+/g, "_");
      let mime = f.mimeType;
      const isMov = f.mimeType === "video/quicktime" || /\.mov$/i.test(f.name);
      if (kind === "video" && isMov) {
        try {
          bytes = await convertToMp4(bytes);
          mime = "video/mp4";
          safeName = safeName.replace(/\.mov$/i, ".mp4");
          if (!/\.mp4$/i.test(safeName)) safeName += ".mp4";
        } catch (convErr) {
          console.error("[driveImport] mov→mp4 failed for", f.name, convErr);
        }
      }
      const { cdnUrl } = await uploadBytes(bytes, `brands/${brandId}/drive/${f.id}_${safeName}`, mime);

      const asset = await prisma.brandAsset.create({
        data: { brandId, url: cdnUrl, kind, category: f.category, label: f.name, driveFileId: f.id },
      });
      imported++;

      try {
        if (kind === "image") {
          const embedUrl = await ensureEmbeddableImage(cdnUrl, `brands/${brandId}/jpeg/${asset.id}.jpg`);
          const vec = await embedImage(embedUrl);
          await insertEmbedding({ assetId: asset.id, brandId, modality: "image", category: f.category, url: cdnUrl, embedding: vec });
          await prisma.brandAsset.update({ where: { id: asset.id }, data: { embedStatus: "ready" } });
          embeddedImages++;
        } else if (kind === "video") {
          const { taskId } = await embedVideoSmart(cdnUrl, `brands/${brandId}/padded/${asset.id}.mp4`);
          await prisma.brandAsset.update({ where: { id: asset.id }, data: { embedTaskId: taskId, embedStatus: "processing" } });
          videos++;
        } else {
          const { taskId } = await embedAudio(cdnUrl);
          await prisma.brandAsset.update({ where: { id: asset.id }, data: { embedTaskId: taskId, embedStatus: "processing" } });
          videos++;
        }
      } catch (embErr) {
        const msg = embErr instanceof Error ? embErr.message : String(embErr);
        console.error("[driveImport] embed failed for", f.name, msg);
        if (embedErrors.length < 3) embedErrors.push(`${f.name}: ${msg}`);
        await prisma.brandAsset.update({ where: { id: asset.id }, data: { embedStatus: "failed", embedError: msg.slice(0, 500) } }).catch(() => {});
      }
    } catch (err) {
      console.error("[driveImport] failed for", f.name, err);
      failed++;
    }
  }

  return {
    ok: true,
    totalInDrive: driveFiles.length,
    newFound: fresh.length,
    imported,
    embeddedImages,
    videos,
    skippedLarge,
    failed,
    embedErrors,
    remaining: Math.max(0, fresh.length - batch.length),
  };
}
