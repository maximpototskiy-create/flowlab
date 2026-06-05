// GET /api/brand-assets/check?brandId=&url=  →  { saved: boolean }
// Lets generation cards show whether an asset is already curated into the
// brand library (so we can show a checkmark instead of the Save button).
import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<NextResponse> {
  await requireUser();
  const { searchParams } = new URL(req.url);
  const brandId = searchParams.get("brandId");
  const url = searchParams.get("url");
  if (!brandId || !url) return NextResponse.json({ saved: false });

  const existing = await prisma.brandAsset.findFirst({
    where: { brandId, url },
    select: { id: true },
  });
  return NextResponse.json({ saved: !!existing });
}
