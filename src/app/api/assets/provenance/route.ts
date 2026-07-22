// GET /api/assets/provenance?id=<assetId>
// Full generation provenance for one asset: model, prompt, the RESOLVED
// reference inputs (URLs captured at run time), node type, seed and a link
// back to the workflow it was generated in. Powers the "how was this made"
// panel in the asset lightbox - open a successful asset, see exactly what
// produced it, copy the recipe.
import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<NextResponse> {
  await requireUser();
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  try {
    const asset = (await prisma.asset.findUnique({
      where: { id },
      select: {
        id: true,
        model: true,
        prompt: true,
        seed: true,
        createdAt: true,
        runStep: {
          select: {
            nodeType: true,
            inputParams: true,
            run: {
              select: {
                triggeredBy: true,
                trigger: { select: { name: true, email: true } },
                workflow: { select: { id: true, projectId: true, name: true } },
              },
            },
          },
        },
      },
    })) as {
      id: string; model: string | null; prompt: string | null; seed: bigint | null; createdAt: Date;
      runStep: {
        nodeType: string;
        inputParams: Record<string, unknown> | null;
        run: { triggeredBy: string; trigger: { name: string | null; email: string }; workflow: { id: string; projectId: string; name: string } | null };
      } | null;
    } | null;
    if (!asset) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const params = (asset.runStep?.inputParams ?? {}) as Record<string, unknown>;
    const refs = Array.isArray(params._refs) ? (params._refs as string[]).filter((r) => typeof r === "string") : [];
    // Config without internal keys - lets the panel show extra settings
    // (aspect, quality, duration) without leaking runtime plumbing.
    const config: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(params)) {
      if (k.startsWith("_") || k === "instructions") continue;
      if (typeof v === "string" && v.length > 300) continue;
      config[k] = v;
    }
    return NextResponse.json({
      model: asset.model,
      prompt: asset.prompt,
      seed: asset.seed != null ? String(asset.seed) : null,
      refs,
      nodeType: asset.runStep?.nodeType ?? null,
      config,
      author: asset.runStep?.run.trigger ? (asset.runStep.run.trigger.name || asset.runStep.run.trigger.email) : null,
      workflow: asset.runStep?.run.workflow ?? null,
      createdAt: asset.createdAt,
    });
  } catch (err) {
    console.error("[assets/provenance] failed:", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
