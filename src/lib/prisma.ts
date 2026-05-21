// src/lib/prisma.ts
// Prisma client singleton, configured for Supabase Transaction Pooler.
//
// Key fixes:
// 1. Singleton via globalThis — survives module re-evaluation in dev hot-reload.
// 2. Disable prepared statements via URL params — transaction pooler (port 6543)
//    doesn't support them, causing "prepared statement already exists" errors (code 42P05).
// 3. Connection limit 1 per function instance — relies on Supabase pooler for
//    multiplexing across all invocations.

import { PrismaClient } from "@prisma/client";

function buildDatabaseUrl(): string | undefined {
  const url = process.env.DATABASE_URL;
  if (!url) return undefined;

  try {
    const u = new URL(url);
    // Force-set the parameters Prisma needs for pgBouncer transaction mode.
    // These override whatever is already there.
    u.searchParams.set("pgbouncer", "true");
    u.searchParams.set("connection_limit", "1");
    u.searchParams.set("pool_timeout", "20");
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
