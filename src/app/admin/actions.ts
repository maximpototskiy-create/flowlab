"use server";

import { requireAdmin } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { revalidatePath } from "next/cache";
import { estimateCost } from "@/lib/fal/pricing";

// Promote/demote a user between "admin" and "member". Admin-only (the guard
// runs server-side here — never trust the client). You can't change your own
// role, so an admin can't accidentally lock themselves out of /admin.
export async function setUserRole(formData: FormData) {
  const admin = await requireAdmin();

  const userId = String(formData.get("userId") ?? "");
  const role = String(formData.get("role") ?? "");

  if (!userId || (role !== "admin" && role !== "member")) {
    return;
  }
  if (userId === admin.id) {
    // No self role-changes — prevents the last admin from demoting themselves.
    return;
  }

  await prisma.user.update({ where: { id: userId }, data: { role } });

  revalidatePath("/admin");
  revalidatePath(`/admin/users/${userId}`);
}


// One-off: re-price EVERY historical run step with the invoice-verified unit
// prices (patch 353) and rebuild run totals. Old rows were recorded with the
// pre-reconciliation estimates; new runs are priced correctly at write time,
// so running this once aligns history with the fal invoices as closely as
// the stored params allow (token-billed endpoints stay approximations).
export async function repriceHistory() {
  await requireAdmin();
  const BATCH = 500;
  let scanned = 0;
  let changed = 0;
  let cursor: string | undefined;
  for (;;) {
    const steps = (await prisma.runStep.findMany({
      where: { model: { not: null } },
      orderBy: { id: "asc" },
      take: BATCH,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      select: { id: true, model: true, costUsd: true, inputParams: true },
    })) as { id: string; model: string | null; costUsd: number; inputParams: unknown }[];
    if (steps.length === 0) break;
    scanned += steps.length;
    const updates: { id: string; cost: number }[] = [];
    for (const st of steps) {
      const p = (st.inputParams ?? {}) as Record<string, unknown>;
      const cost = estimateCost(st.model!, {
        duration: Number(p.duration) || undefined,
        numImages: Number(p.num_results ?? p.numImages ?? p.num_images) || undefined,
        resolution: String(p.resolution ?? ""),
      });
      if (Math.abs(cost - st.costUsd) > 1e-9) updates.push({ id: st.id, cost });
    }
    if (updates.length > 0) {
      // One VALUES-join UPDATE per batch - orders of magnitude faster than
      // row-by-row updates through the pooler.
      const values = updates.map((u) => `('${u.id}'::uuid, ${u.cost.toFixed(6)}::float8)`).join(",");
      await prisma.$executeRawUnsafe(
        `UPDATE run_steps AS r SET cost_usd = v.cost FROM (VALUES ${values}) AS v(id, cost) WHERE r.id = v.id`,
      );
      changed += updates.length;
    }
    cursor = steps[steps.length - 1].id;
  }
  // Rebuild run totals in a single statement.
  await prisma.$executeRawUnsafe(
    `UPDATE runs SET total_cost_usd = s.total FROM (SELECT run_id, COALESCE(SUM(cost_usd),0) AS total FROM run_steps GROUP BY run_id) s WHERE runs.id = s.run_id`,
  );
  console.log(`[repriceHistory] scanned=${scanned} changed=${changed}`);
  revalidatePath("/admin");
}
