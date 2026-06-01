import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { refreshSignedUrl, kindFromMime } from "@/lib/storage";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

// Step 2 of direct-to-Supabase upload. After the browser has PUT the file
// straight into storage (via the signed upload URL), it calls this to
// register an Asset row and get back a signed DOWNLOAD url that fal models
// can fetch. Bytes don't pass through here either — just metadata.
export async function POST(req: Request) {
  const user = await requireUser();

  const body = (await req.json().catch(() => ({}))) as {
    storagePath?: string;
    mime?: string;
    sizeBytes?: number;
    brandId?: string | null;
    projectId?: string | null;
  };

  if (!body.storagePath) {
    return NextResponse.json({ error: "No storagePath" }, { status: 400 });
  }

  const mime = body.mime ?? "application/octet-stream";
  const kind = kindFromMime(mime);
  // 30-day signed download URL (same TTL the server-side uploadBytes uses).
  const cdnUrl = await refreshSignedUrl(body.storagePath);

  const asset = await prisma.asset.create({
    data: {
      brandId: body.brandId ?? null,
      projectId: body.projectId ?? null,
      storagePath: body.storagePath,
      cdnUrl,
      kind,
      mimeType: mime,
      sizeBytes: body.sizeBytes ? BigInt(body.sizeBytes) : null,
      source: "upload",
      uploadedBy: user.id,
    },
  });

  return NextResponse.json({
    id: asset.id,
    cdnUrl,
    storagePath: body.storagePath,
    kind,
    mimeType: mime,
  });
}
