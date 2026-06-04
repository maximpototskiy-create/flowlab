// GET /api/brands → minimal brand list for pickers.
import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  await requireUser();
  const brands = await prisma.brand.findMany({
    where: { archivedAt: null },
    select: { id: true, name: true, slug: true },
    orderBy: { name: "asc" },
  });
  return NextResponse.json({ brands });
}
