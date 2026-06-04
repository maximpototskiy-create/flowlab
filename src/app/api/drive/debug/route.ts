// GET /api/drive/debug?brandId=…
// Diagnoses Drive import step by step without downloading anything.
// Returns where it stops: env, brand, folder resolution, file count, samples.
import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { findBrandFolder, collectBrandFiles, listSubfolderNames } from "@/lib/drive/client";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request): Promise<NextResponse> {
  await requireUser();
  const { searchParams } = new URL(req.url);
  const brandId = searchParams.get("brandId");
  if (!brandId) return NextResponse.json({ error: "brandId query param required" }, { status: 400 });

  const out: Record<string, unknown> = {};
  out.hasServiceAccountJson = !!process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  out.libraryFolderIdSet = !!process.env.DRIVE_LIBRARY_FOLDER_ID;

  const brand = await prisma.brand.findUnique({ where: { id: brandId } });
  if (!brand) return NextResponse.json({ ...out, error: "brand not found" }, { status: 404 });
  out.brandName = brand.name;
  out.savedDriveFolderId = (brand as { driveFolderId?: string | null }).driveFolderId ?? null;

  // Step 1: what does the service account see in the library folder?
  const libraryId = process.env.DRIVE_LIBRARY_FOLDER_ID;
  if (libraryId) {
    try {
      out.librarySubfolders = await listSubfolderNames(libraryId);
    } catch (err) {
      out.libraryListError = err instanceof Error ? err.message : String(err);
    }
  }

  // Step 2: resolve the brand folder (saved id, else by name).
  let folderId = (brand as { driveFolderId?: string | null }).driveFolderId ?? null;
  if (!folderId && libraryId) {
    try {
      folderId = await findBrandFolder(libraryId, brand.name);
      out.resolvedByName = folderId;
    } catch (err) {
      out.findFolderError = err instanceof Error ? err.message : String(err);
    }
  }
  out.usingFolderId = folderId;

  // Step 3: list files under the brand folder.
  if (folderId) {
    try {
      const files = await collectBrandFiles(folderId);
      out.fileCount = files.length;
      out.sample = files.slice(0, 8).map((f) => ({ name: f.name, category: f.category, mime: f.mimeType, sizeMB: f.sizeBytes ? Math.round(f.sizeBytes / 1048576) : null }));
      out.categories = [...new Set(files.map((f) => f.category))];
    } catch (err) {
      out.collectError = err instanceof Error ? err.message : String(err);
    }
  } else {
    out.note = "No folder resolved. Check that DRIVE_LIBRARY_FOLDER_ID points to the FlowLab folder, that the brand folder name matches the brand name, and that the FlowLab folder is shared with the service account.";
  }

  return NextResponse.json(out);
}
