// src/lib/auth.ts
// Helper to get the current authenticated user.
// Use in Server Components, Server Actions, and API routes.

import { createClient } from "@/lib/supabase/server";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";

export async function getCurrentUser() {
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

  // Update last seen (fire-and-forget, no await needed)
  prisma.user
    .update({
      where: { id: user.id },
      data: { lastSeenAt: new Date() },
    })
    .catch(() => {});

  return profile;
}

export async function requireUser() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}
