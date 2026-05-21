// src/app/api/health/route.ts
// Health check for monitoring and deploy verification.
// Visit /api/health to see if backend + database are alive.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const checks: Record<string, "ok" | "error" | "skipped"> = {
    api: "ok",
    database: "skipped",
    env: "skipped",
  };

  // Check env vars
  const requiredEnv = [
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
    "DATABASE_URL",
  ];
  const missingEnv = requiredEnv.filter((k) => !process.env[k]);
  checks.env = missingEnv.length === 0 ? "ok" : "error";

  // Check database
  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.database = "ok";
  } catch {
    checks.database = "error";
  }

  const allOk = Object.values(checks).every((v) => v === "ok");

  return NextResponse.json(
    {
      status: allOk ? "healthy" : "degraded",
      timestamp: new Date().toISOString(),
      checks,
      missingEnvVars: missingEnv.length > 0 ? missingEnv : undefined,
    },
    { status: allOk ? 200 : 503 }
  );
}
