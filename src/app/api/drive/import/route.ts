// POST /api/drive/import { brandId }
// Imports new files from the brand's Google Drive folder into our library:
//   Drive → download → Supabase storage → brand_asset → embed (img/video).
// Dedup by drive_file_id. Batched + size-capped so serverless stays safe.
import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { findBrandFolder, collectBrandFiles, downloadDriveFile, type DriveFile } from "@/lib/drive/client";
import { uploadBytes } from "@/lib/storage";
import { embedImage, embedVideo, embedAudio } from "@/lib/twelvelabs/embed";
import { insertEmbedding } from "@/lib/semantic";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MAX_PER_RUN = 20; // import at most N new files per call (re-run for more)
const MAX_BYTES = 200 * 1024 * 1024; // skip files larger than 200 MB for now

export async function POST(req: Request): Promise<NextResponse> {
  await requireUser();
  let body: { brandId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }
  const { brandId } = body;
  if (!brandId) return NextResponse.json({ error: "brandId required" }, { status: 400 });

  const brand = await prisma.brand.findUnique({ where: { id: brandId } });
  if (!brand) return NextResponse.json({ error: "brand not found" }, { status: 404 });

  // Resolve the brand's Drive folder: stored id, or look it up by brand name
  // inside the shared library folder (DRIVE_LIBRARY_FOLDER_ID).
  let folderId = (brand as { driveFolderId?: string | null }).driveFolderId ?? null;
  if (!folderId) {
    const libraryId = process.env.DRIVE_LIBRARY_FOLDER_ID;
    if (!libraryId) return NextResponse.json({ error: "No drive folder set for brand and DRIVE_LIBRARY_FOLDER_ID is missing" }, { status: 400 });
    try {
      folderId = await findBrandFolder(libraryId, brand.name);
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : "Drive auth failed" }, { status: 500 });
    }
    if (!folderId) return NextResponse.json({ error: `No Drive folder named "${brand.name}" found in the library` }, { status: 404 });
    await prisma.brand.update({ where: { id: brandId }, data: { driveFolderId: folderId } });
  }

  // List Drive files and skip those we already imported.
  let driveFiles: DriveFile[];
  try {
    driveFiles = await collectBrandFiles(folderId);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Drive list failed" }, { status: 500 });
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
  const batch = fresh.slice(0, MAX_PER_RUN);

  for (const f of batch) {
    if (f.sizeBytes && f.sizeBytes > MAX_BYTES) {
      skippedLarge++;
      continue;
    }
    const kind = f.mimeType.startsWith("video/") ? "video" : f.mimeType.startsWith("audio/") ? "audio" : "image";
    try {
      const bytes = await downloadDriveFile(f.id);
      const safeName = f.name.replace(/[^\w.\-]+/g, "_");
      const { cdnUrl } = await uploadBytes(bytes, `brands/${brandId}/drive/${f.id}_${safeName}`, f.mimeType);

      const asset = await prisma.brandAsset.create({
        data: { brandId, url: cdnUrl, kind, category: f.category, label: f.name, driveFileId: f.id },
      });
      imported++;

      // Embed (best-effort).
      try {
        if (kind === "image") {
          const vec = await embedImage(cdnUrl);
          await insertEmbedding({ assetId: asset.id, brandId, modality: "image", category: f.category, url: cdnUrl, embedding: vec });
          await prisma.brandAsset.update({ where: { id: asset.id }, data: { embedStatus: "ready" } });
          embeddedImages++;
        } else if (kind === "video") {
          const { taskId } = await embedVideo(cdnUrl);
          await prisma.brandAsset.update({ where: { id: asset.id }, data: { embedTaskId: taskId, embedStatus: "processing" } });
          videos++;
        } else {
          // audio
          const { taskId } = await embedAudio(cdnUrl);
          await prisma.brandAsset.update({ where: { id: asset.id }, data: { embedTaskId: taskId, embedStatus: "processing" } });
          videos++;
        }
      } catch (embErr) {
        console.error("[drive/import] embed failed for", f.name, embErr);
        await prisma.brandAsset.update({ where: { id: asset.id }, data: { embedStatus: "failed" } }).catch(() => {});
      }
    } catch (err) {
      console.error("[drive/import] failed for", f.name, err);
      failed++;
    }
  }

  const remaining = fresh.length - batch.length + skippedLarge;
  return NextResponse.json({
    ok: true,
    totalInDrive: driveFiles.length,
    newFound: fresh.length,
    imported,
    embeddedImages,
    videos,
    skippedLarge,
    failed,
    remaining: Math.max(0, remaining),
  });
}
