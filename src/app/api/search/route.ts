// GET /api/search?q= - global search across projects, workflows, brands and
// (for admins) users. Powers the Cmd+K palette in the top nav. Name-based
// case-insensitive matching, capped per group, newest-first.
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<NextResponse> {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const q = (new URL(req.url).searchParams.get("q") ?? "").trim();
  if (q.length < 2) return NextResponse.json({ results: [] });
  const contains = { contains: q, mode: "insensitive" as const };
  try {
    const [projects, workflows, brands, users] = await Promise.all([
      prisma.project.findMany({
        where: { archivedAt: null, name: contains },
        orderBy: { updatedAt: "desc" },
        take: 5,
        select: { id: true, name: true, brand: { select: { name: true } }, creator: { select: { name: true, email: true } } },
      }),
      prisma.workflow.findMany({
        where: { name: contains },
        orderBy: { updatedAt: "desc" },
        take: 7,
        select: { id: true, projectId: true, name: true, project: { select: { name: true } } },
      }),
      prisma.brand.findMany({
        where: { archivedAt: null, name: contains },
        orderBy: { name: "asc" },
        take: 4,
        select: { id: true, name: true, slug: true },
      }),
      user.role === "admin"
        ? prisma.user.findMany({
            where: { OR: [{ name: contains }, { email: contains }] },
            take: 4,
            select: { id: true, name: true, email: true },
          })
        : Promise.resolve([]),
    ]);
    type Result = { group: string; label: string; sub?: string; href: string };
    type ProjRow = { id: string; name: string; brand: { name: string } | null; creator: { name: string | null; email: string } | null };
    type WfRow = { id: string; projectId: string; name: string; project: { name: string } | null };
    type BrandRow = { id: string; name: string; slug: string };
    const results: Result[] = [
      ...(projects as ProjRow[]).map((p) => ({ group: "Projects", label: p.name, sub: [p.brand?.name, p.creator?.name || p.creator?.email].filter(Boolean).join(" - "), href: `/projects/${p.id}` })),
      ...(workflows as WfRow[]).map((w) => ({ group: "Workflows", label: w.name, sub: w.project?.name ?? undefined, href: `/projects/${w.projectId}/workflows/${w.id}` })),
      ...(brands as BrandRow[]).map((b) => ({ group: "Brands", label: b.name, href: `/brands/${b.slug}` })),
      ...(users as { id: string; name: string | null; email: string }[]).map((u) => ({ group: "People", label: u.name || u.email, sub: u.email, href: `/admin/users/${u.id}` })),
    ];
    return NextResponse.json({ results });
  } catch (err) {
    console.error("[api/search] failed:", err);
    return NextResponse.json({ results: [] }, { status: 500 });
  }
}
