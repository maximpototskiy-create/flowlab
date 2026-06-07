// src/lib/auth.ts
// Helper to get the current authenticated user.
// Use in Server Components, Server Actions, and API routes.

import { createClient } from "@/lib/supabase/server";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { cache } from "react";

// Throttle lastSeenAt writes: at most once per user per 5 min, per lambda.
// Previously every request (incl. 5s polling) issued an UPDATE, each taking a
// pooled connection — a major contributor to pool exhaustion under load.
const lastSeenWrites = new Map<string, number>();
const LAST_SEEN_THROTTLE_MS = 5 * 60 * 1000;

export const getCurrentUser = cache(async () => {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return null;

  // Get the profile row from our DB
  let profile = await prisma.user.findUnique({ where: { id: user.id } });

  // Race condition safety: create profile if missing
  if (!profile) {
    profile = await prisma.user.create({
      data: {
        id: user.id,
        email: user.email!,
        role: "member",
      },
    });
  }

  // Update last seen — throttled, fire-and-forget. Avoids an UPDATE (and a
  // pooled connection) on every single request.
  const now = Date.now();
  const last = lastSeenWrites.get(user.id) ?? 0;
  if (now - last > LAST_SEEN_THROTTLE_MS) {
    lastSeenWrites.set(user.id, now);
    prisma.user
      .update({
        where: { id: user.id },
        data: { lastSeenAt: new Date() },
      })
      .catch(() => {});
  }

  return profile;
});

export async function requireUser() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}

// Gate for admin-only pages/routes. Non-admins are bounced to the dashboard.
export async function requireAdmin() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role !== "admin") redirect("/dashboard");
  return user;
}
