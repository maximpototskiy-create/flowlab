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
    // Per Supabase official docs for serverless:
    // "set connection_limit=1 and gradually increase if necessary"
    // Supavisor (pgBouncer) multiplexes connections server-side, so each lambda
    // only needs 1. Higher values cause cascade failures under load.
    // https://supabase.com/docs/guides/troubleshooting/prisma-error-management
    u.searchParams.set("connection_limit", "1");
    // Short pool_timeout — fail fast and let the request retry rather than
    // hang holding up other queries.
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
