"use server";

import { requireAdmin } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { revalidatePath } from "next/cache";

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
