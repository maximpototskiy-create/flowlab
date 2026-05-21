// src/app/auth/callback/route.ts
// Handles the magic link redirect from email.
// Exchanges the one-time code for a session, then upserts our User row.

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { prisma } from "@/lib/prisma";

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/dashboard";

  if (!code) {
    return NextResponse.redirect(`${origin}/login?error=missing_code`);
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);

  if (error || !data.user) {
    console.error("Auth exchange failed:", error);
    return NextResponse.redirect(`${origin}/login?error=auth_failed`);
  }

  // Upsert user profile in our DB. First-time login → creates row.
  // Subsequent logins → updates lastSeenAt.
  try {
    await prisma.user.upsert({
      where: { id: data.user.id },
      update: {
        email: data.user.email!,
        lastSeenAt: new Date(),
      },
      create: {
        id: data.user.id,
        email: data.user.email!,
        role: "member",
      },
    });
  } catch (err) {
    console.error("Failed to upsert user profile:", err);
    // Don't block login — the auth session is valid, we just couldn't
    // sync the profile row. The dashboard will retry.
  }

  return NextResponse.redirect(`${origin}${next}`);
}
