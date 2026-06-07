// POST /api/agent/build-workflow — natural-language brief → validated Graph.
// Body: { brief: string, brandHint?: string }
// Returns: { graph, summary, warnings } or { error }.
import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { buildWorkflowGraph } from "@/lib/agent/buildWorkflow";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request): Promise<NextResponse> {
  await requireUser();

  let body: { brief?: string; brandHint?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }
  if (!body.brief?.trim()) {
    return NextResponse.json({ error: "brief required" }, { status: 400 });
  }

  try {
    const result = await buildWorkflowGraph(body.brief, { brandHint: body.brandHint });
    return NextResponse.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Build failed";
    console.error("[api/agent/build-workflow] failed:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
