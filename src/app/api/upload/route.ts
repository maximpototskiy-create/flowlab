import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { uploadBytes, buildStoragePath, kindFromMime } from "@/lib/storage";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: Request) {
  const user = await requireUser();
  const form = await req.formData();
  const file = form.get("file") as File | null;
  const brandId = (form.get("brandId") as string | null) ?? null;
  const projectId = (form.get("projectId") as string | null) ?? null;
  const workflowId = (form.get("workflowId") as string | null) ?? null;

  if (!file) return NextResponse.json({ error: "No file" }, { status: 400 });

  const bytes = await file.arrayBuffer();
  const mime = file.type || "application/octet-stream";
  const kind = kindFromMime(mime);
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "bin";

  const storagePath = buildStoragePath({
    brandId,
    projectId,
    workflowId,
    runStepId: `upload-${Date.now()}`,
    prefix: "upload",
    ext,
  });

  const result = await uploadBytes(bytes, storagePath, mime);

  const asset = await prisma.asset.create({
    data: {
      brandId,
      projectId,
      storagePath: result.storagePath,
      cdnUrl: result.cdnUrl,
      kind,
      mimeType: mime,
      sizeBytes: BigInt(result.sizeBytes),
      source: "upload",
      uploadedBy: user.id,
    },
  });

  return NextResponse.json({
    id: asset.id,
    cdnUrl: result.cdnUrl,
    storagePath: result.storagePath,
    kind,
    mimeType: mime,
    sizeBytes: result.sizeBytes,
  });
}
