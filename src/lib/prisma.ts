// src/lib/prisma.ts
// Prisma client singleton, configured for Supabase Transaction Pooler.
//
// Key fixes:
// 1. Singleton via globalThis — survives module re-evaluation in dev hot-reload.
// 2. Disable prepared statements via URL params — transaction pooler (port 6543)
//    doesn't support them, causing "prepared statement already exists" errors (code 42P05).
// 3. connection_limit=3 — was 1, but Supabase official docs literally say
//    "set connection_limit=1 AND GRADUALLY INCREASE IF NECESSARY". Reality:
//    we have `after()` background jobs in /api/runs/start that hold a connection
//    for 30-180s while waiting on fal.ai. With limit=1, every other request
//    (dashboard, page loads, polling) waits the full pool_timeout and then
//    500s. Raising to 3 makes background+foreground+polling coexist.
//    Supabase pooler still multiplexes server-side; we're not making 3 real
//    db connections, just 3 slots into the pooler.

import { PrismaClient } from "@prisma/client";

function buildDatabaseUrl(): string | undefined {
  const url = process.env.DATABASE_URL;
  if (!url) return undefined;

  try {
    const u = new URL(url);
    // Force-set the parameters Prisma needs for pgBouncer transaction mode.
    // These override whatever is already there.
    u.searchParams.set("pgbouncer", "true");
    // Raised from 1 → 3 to handle long-running `after()` background jobs that
    // would otherwise starve all other requests. Supavisor (pgBouncer) still
    // multiplexes server-side, so we're not actually opening 3 PG sessions —
    // just allowing 3 concurrent pooler clients per lambda instance.
    // Symptom this fixes: dashboard/workflow pages returning 500 with
    // "P2024: Timed out fetching a new connection from the connection pool"
    // while a long generation is running.
    u.searchParams.set("connection_limit", "3");
    // Shorter pool_timeout — fail fast (5s) and let the request retry rather
    // than make the user stare at a white screen for 20s before 500. With
    // connection_limit=3 we expect waits to be rare; if they happen we want
    // them visible quickly.
    u.searchParams.set("pool_timeout", "5");
    // Disable Prisma's prepared statement caching — pgBouncer transaction mode
    // doesn't preserve session state between queries, so cached statements collide.
    if (!u.searchParams.has("statement_cache_size")) {
      u.searchParams.set("statement_cache_size", "0");
    }
    return u.toString();
  } catch {
    return url;
  }
}

function makeClient() {
  return new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
    datasourceUrl: buildDatabaseUrl(),
  });
}

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? makeClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
