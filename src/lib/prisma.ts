// src/lib/prisma.ts
// Prisma client singleton, configured for Supabase Transaction Pooler (port 6543).
//
// Key points:
// 1. Singleton via globalThis — survives module re-evaluation in dev hot-reload.
// 2. Disable prepared statements via URL params — the transaction pooler doesn't
//    preserve session state, so cached prepared statements collide (code 42P05).
// 3. connection_limit=1 — this is the CORRECT value for a transaction pooler in
//    serverless, and reverts a bad bump to 15 that caused a site-wide outage.
//    Why 1: each Vercel lambda instance gets its own Prisma pool. Supavisor (the
//    pooler) only has a small fixed pool of REAL Postgres connections (default
//    15). When many instances each demand several connections at once — the
//    Brand Assets node fires one /api/brand-assets/check per asset (dozens at a
//    time), plus run-status polling, plus a running generation — the pooler's
//    real-PG pool stays saturated past its 60s checkout timeout and every query
//    fails with FATAL (ECHECKOUTTIMEOUT), cascading to all routes.
//    With limit=1 each lambda holds at most one connection, so peak concurrent
//    transactions ≈ peak concurrent lambdas (observed ≤ 8) — comfortably under
//    the pooler's pool. The pooler multiplexes; we don't need a big client pool.
//    Long background work (generations) runs on Inngest in its own invocations,
//    so request handlers no longer hold a connection across a long external call
//    — which was the original (now obsolete) reason the limit had been raised.

import { PrismaClient } from "@prisma/client";

function buildDatabaseUrl(): string | undefined {
  const url = process.env.DATABASE_URL;
  if (!url) return undefined;

  try {
    const u = new URL(url);
    // Force-set the parameters Prisma needs for pgBouncer transaction mode.
    // These override whatever is already there.
    u.searchParams.set("pgbouncer", "true");
    // One connection per serverless instance. Raising this does NOT help — the
    // bottleneck is the pooler's server-side pool of real Postgres connections,
    // not the client pool — and it actively hurts: a high limit lets a handful
    // of instances drain the pooler, producing FATAL (ECHECKOUTTIMEOUT) for
    // everyone. The pooler multiplexes, so 1 is the right value here.
    u.searchParams.set("connection_limit", "1");
    // pool_timeout: how long a query waits for a free client-pool slot before
    // P2024. With limit=1 and sequential queries per request this is rarely hit;
    // kept generous so brief spikes queue instead of erroring.
    u.searchParams.set("pool_timeout", "15");
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
