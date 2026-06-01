import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { createUploadUrl, buildStoragePath, BUCKET } from "@/lib/storage";

export const runtime = "nodejs";

// Step 1 of direct-to-Supabase upload (for large files like video that
// exceed the ~4.5MB serverless body limit). Returns a one-time signed
// upload token + the storage path. The browser then PUTs the file
// straight into Supabase via uploadToSignedUrl — the bytes never touch
// this function, so there's no body-size limit on the actual file.
export async function POST(req: Request) {
  await requireUser();

  const body = (await req.json().catch(() => ({}))) as {
    ext?: string;
    brandId?: string | null;
    projectId?: string | null;
    workflowId?: string | null;
  };

  const storagePath = buildStoragePath({
    brandId: body.brandId ?? null,
    projectId: body.projectId ?? null,
    workflowId: body.workflowId ?? null,
    runStepId: `upload-${Date.now()}`,
    prefix: "upload",
    ext: body.ext ?? "bin",
  });

  const { path, token } = await createUploadUrl(storagePath);
  return NextResponse.json({ bucket: BUCKET, path, token });
}
