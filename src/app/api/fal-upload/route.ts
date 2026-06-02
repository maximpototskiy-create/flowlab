// POST /api/fal-upload — uploads a user image to fal storage and returns a
// fal-hosted URL, suitable for the Browse-assets `search_image_url` (semantic
// image search). The fal key stays on the server.
//
// Body: multipart/form-data with a single `file` field (image).
import { NextResponse } from "next/server";
import { fal } from "@fal-ai/client";
import { requireUser } from "@/lib/auth";
import { nextFalKey } from "@/lib/fal/client";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<NextResponse> {
  await requireUser();

  let key: string;
  try {
    key = nextFalKey();
  } catch {
    return NextResponse.json({ error: "No fal key configured" }, { status: 500 });
  }
  fal.config({ credentials: key });

  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof Blob)) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }
    if (file.size > 20 * 1024 * 1024) {
      return NextResponse.json({ error: "File too large (max 20MB)" }, { status: 413 });
    }
    // Upload to fal CDN → public fal-hosted URL. Keep it (no early expiry).
    const url = await fal.storage.upload(file, { lifecycle: { expiresIn: "never" } });
    return NextResponse.json({ url });
  } catch (err) {
    console.error("[api/fal-upload] failed:", err);
    return NextResponse.json({ error: "Upload failed" }, { status: 500 });
  }
}
