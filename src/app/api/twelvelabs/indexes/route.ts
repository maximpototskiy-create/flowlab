import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { listIndexes } from "@/lib/twelvelabs/client";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(): Promise<NextResponse> {
  await requireUser();
  try {
    const indexes = await listIndexes();
    return NextResponse.json({ indexes });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to list indexes";
    return NextResponse.json({ indexes: [], error: msg }, { status: 500 });
  }
}
