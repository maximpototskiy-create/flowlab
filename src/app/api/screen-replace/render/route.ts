// POST /api/screen-replace/render — composite a green-screen source with content
// using the SAME server compositor as the Screen Replace node (keying, despill,
// matte, corner-pin track correction). Returns the finished video URL so the
// timeline editor can drop it in as a clip — i.e. node-quality screen replace
// authored inside the editor.
import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { compositeGreenScreen } from "@/lib/video";
import { uploadBytes, buildStoragePath } from "@/lib/storage";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

type Body = {
  source?: string;
  content?: string;
  contentIsVideo?: boolean;
  keyColorHex?: string;
  similarity?: number;
  fit?: "fill" | "cover";
  scaleX?: number;
  scaleY?: number;
  matteChoke?: number;
  feather?: number;
  trackKeys?: { t: number; c?: number[][]; dx?: number; dy?: number; rot?: number }[];
  trackMode?: "region" | "keys" | "anchor";
  projectId?: string;
  workflowId?: string;
};

export async function POST(req: Request): Promise<NextResponse> {
  await requireUser();
  let body: Body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }
  const source = (body.source || "").trim();
  const content = (body.content || "").trim();
  if (!source) return NextResponse.json({ error: "source (green-screen video url) required" }, { status: 400 });
  if (!content) return NextResponse.json({ error: "content (image/video url) required" }, { status: 400 });

  let srcBuf: Buffer, contentBuf: Buffer;
  try {
    const [s, c] = await Promise.all([fetch(source), fetch(content)]);
    if (!s.ok) return NextResponse.json({ error: `Could not fetch source (${s.status})` }, { status: 502 });
    if (!c.ok) return NextResponse.json({ error: `Could not fetch content (${c.status})` }, { status: 502 });
    srcBuf = Buffer.from(await s.arrayBuffer());
    contentBuf = Buffer.from(await c.arrayBuffer());
  } catch (e) {
    return NextResponse.json({ error: `Fetch failed: ${e instanceof Error ? e.message : "error"}` }, { status: 502 });
  }

  let outBuf: Buffer;
  try {
    outBuf = await compositeGreenScreen({
      source: srcBuf,
      content: contentBuf,
      contentIsVideo: Boolean(body.contentIsVideo),
      keyColorHex: body.keyColorHex || "#00FF00",
      similarity: typeof body.similarity === "number" && body.similarity > 0 ? body.similarity : 0.3,
      fit: body.fit === "cover" ? "cover" : "fill",
      scaleX: typeof body.scaleX === "number" && body.scaleX > 0 ? body.scaleX : 1,
      scaleY: typeof body.scaleY === "number" && body.scaleY > 0 ? body.scaleY : 1,
      matteChoke: typeof body.matteChoke === "number" ? body.matteChoke : 0,
      feather: typeof body.feather === "number" ? body.feather : 0,
      trackKeys: Array.isArray(body.trackKeys) ? body.trackKeys : [],
      trackMode: body.trackMode === "keys" || body.trackMode === "region" ? body.trackMode : "anchor",
    });
  } catch (e) {
    return NextResponse.json({ error: `Render failed: ${e instanceof Error ? e.message : "error"}` }, { status: 500 });
  }

  const path = buildStoragePath({ projectId: body.projectId ?? null, workflowId: body.workflowId ?? null, prefix: "screen-replace", ext: "mp4" });
  const { cdnUrl } = await uploadBytes(outBuf, path, "video/mp4");
  if (!cdnUrl) return NextResponse.json({ error: "Upload failed" }, { status: 500 });
  return NextResponse.json({ url: cdnUrl });
}
