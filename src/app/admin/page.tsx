// src/app/admin/page.tsx
// Admin-only usage dashboard: per-user generation volume + cost, and a
// per-model cost breakdown. Server-rendered (no polling) and gated by
// requireAdmin(), so it never adds to status-poll pool pressure.
import Link from "next/link";
import TopNav from "@/components/TopNav";
import { requireAdmin } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { setUserRole, repriceHistory } from "./actions";
import { directUnitEst } from "@/lib/adminPricing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// repriceHistory (server action) walks every run step - give it room.
export const maxDuration = 300;

const RANGES = [
  { key: "7", label: "7 days" },
  { key: "30", label: "30 days" },
  { key: "all", label: "All time" },
];

// Cost is tracked in USD (Run.totalCostUsd / RunStep.costUsd). AI spend is
// usually fractions of a dollar, so show more precision for small numbers.
function usd(n: number) {
  return "$" + (n < 1 ? n.toFixed(4) : n.toFixed(2));
}

// Explicit shapes for the Prisma aggregate results. These mirror what
// run.groupBy / runStep.groupBy return at runtime; declaring them keeps this
// file self-typed (and tsc-clean) regardless of whether the generated Prisma
// client is present in the current environment.
type UserRow = { id: string; email: string; name: string | null; role: string; lastSeenAt: Date | null };
type RunAggRow = { triggeredBy: string; _count: { _all: number }; _sum: { totalCostUsd: number | null } };
type StatusAggRow = { triggeredBy: string; status: string; _count: { _all: number } };
type ModelAggRow = { model: string | null; _count: { _all: number }; _sum: { costUsd: number | null } };
type DirectAggRow = { model: string | null; _count: { _all: number } };

export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  const admin = await requireAdmin();

  const sp = await searchParams;
  const range = sp.range === "7" || sp.range === "30" ? sp.range : "all";
  const since = range === "all" ? undefined : new Date(Date.now() - Number(range) * 86_400_000);
  const runWhere = since ? { startedAt: { gte: since } } : {};
  const stepWhere = since ? { startedAt: { gte: since } } : {};

  const [users, runAgg, statusAgg, modelAgg] = (await Promise.all([
    prisma.user.findMany({
      select: { id: true, email: true, name: true, role: true, lastSeenAt: true },
    }),
    prisma.run.groupBy({
      by: ["triggeredBy"],
      where: runWhere,
      _count: { _all: true },
      _sum: { totalCostUsd: true },
    }),
    prisma.run.groupBy({
      by: ["triggeredBy", "status"],
      where: runWhere,
      _count: { _all: true },
    }),
    prisma.runStep.groupBy({
      by: ["model"],
      where: stepWhere,
      _count: { _all: true },
      _sum: { costUsd: true },
      orderBy: { _sum: { costUsd: "desc" } },
    }),
  ])) as unknown as [UserRow[], RunAggRow[], StatusAggRow[], ModelAggRow[]];

  // Direct (corp-key) generations: real asset counts per model + HeyGen renders.
  const assetWhere = since ? { createdAt: { gte: since } } : {};
  const [directAgg, heygenCount] = (await Promise.all([
    prisma.asset.groupBy({
      by: ["model"],
      where: {
        source: "generated",
        OR: [{ model: { startsWith: "google/" } }, { model: { startsWith: "openai/" } }],
        ...assetWhere,
      },
      _count: { _all: true },
    }),
    prisma.runStep.count({
      where: { nodeType: "heygenVideo", status: "done", ...(since ? { startedAt: { gte: since } } : {}) },
    }),
  ])) as unknown as [DirectAggRow[], number];
  const directRows = directAgg
    .filter((d) => d.model)
    .map((d) => ({ model: d.model!, count: d._count._all, est: d._count._all * directUnitEst(d.model!) }))
    .sort((a, b) => b.count - a.count);
  const directTotal = directRows.reduce((s, r) => s + r.count, 0);
  const directEstTotal = directRows.reduce((s, r) => s + r.est, 0);

  const runByUser = new Map(runAgg.map((r) => [r.triggeredBy, r]));
  const doneByUser = new Map<string, number>();
  const errByUser = new Map<string, number>();
  for (const s of statusAgg) {
    if (s.status === "done") doneByUser.set(s.triggeredBy, s._count._all);
    if (s.status === "error") errByUser.set(s.triggeredBy, s._count._all);
  }

  const rows = users
    .map((u) => {
      const agg = runByUser.get(u.id);
      return {
        id: u.id,
        email: u.email,
        name: u.name,
        role: u.role,
        lastSeenAt: u.lastSeenAt,
        runs: agg?._count._all ?? 0,
        cost: agg?._sum.totalCostUsd ?? 0,
        done: doneByUser.get(u.id) ?? 0,
        errors: errByUser.get(u.id) ?? 0,
      };
    })
    .sort((a, b) => b.cost - a.cost || b.runs - a.runs);

  const totalRuns = rows.reduce((s, r) => s + r.runs, 0);
  const totalCost = rows.reduce((s, r) => s + r.cost, 0);
  const activeUsers = rows.filter((r) => r.runs > 0).length;

  return (
    <div className="min-h-screen bg-bg">
      <TopNav activeNav="admin" />
      <main className="max-w-7xl mx-auto px-6 lg:px-10 py-8">
        <div className="flex items-end justify-between mb-6 flex-wrap gap-3">
          <div>
            <h1 className="font-display text-3xl">Admin · Usage</h1>
            <p className="text-fg-muted text-sm mt-1">Generation volume and cost per user.</p>
          </div>
          <div className="flex items-center gap-1">
            {RANGES.map((r) => (
              <a
                key={r.key}
                href={`/admin?range=${r.key}`}
                className={`px-3 py-1.5 rounded-md text-[11px] border transition ${
                  range === r.key
                    ? "bg-brand/15 border-brand text-brand"
                    : "border-border text-fg-muted hover:text-fg hover:border-border-strong"
                }`}
              >
                {r.label}
              </a>
            ))}
          </div>
        </div>

        {/* Summary */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-8">
          <Card label="Total runs" value={String(totalRuns)} />
          <Card label="Total cost (fal)" value={usd(totalCost)} />
          <Card label="Direct generations" value={String(directTotal)} />
          <Card label="Direct est. cost" value={"~" + usd(directEstTotal)} />
          <Card label="Combined est." value={"~" + usd(totalCost + directEstTotal)} />
          <Card label="Active users" value={`${activeUsers} / ${users.length}`} />
        </div>

        <div className="mb-6 flex items-center gap-2 flex-wrap">
          <Link href={`/admin/errors`} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-red-500/40 text-red-400 hover:bg-red-500/10 text-[11px] uppercase tracking-wider transition">
            Generation errors &rarr;
          </Link>
          <form action={repriceHistory}>
            <button type="submit"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-border text-fg-muted hover:text-fg hover:border-border-strong text-[11px] uppercase tracking-wider transition"
              title="One-off: re-price all historical run steps with the invoice-verified unit prices and rebuild run totals. Takes up to a minute.">
              Reprice history
            </button>
          </form>
        </div>

        {/* Direct (corp keys) - real counts, estimated price. These are billed
            outside fal, so the fal totals above do NOT include them. */}
        <h2 className="text-[11px] uppercase tracking-wider text-fg-subtle mb-2">Direct generations (corp keys) - {RANGES.find((r) => r.key === range)?.label ?? "All time"}</h2>
        <div className="surface p-4 mb-8">
          {directRows.length === 0 && heygenCount === 0 ? (
            <div className="text-fg-subtle text-sm">No direct generations in this period.</div>
          ) : (
            <table className="w-full text-[12px]">
              <thead>
                <tr className="text-left text-fg-subtle text-[10px] uppercase tracking-wider">
                  <th className="pb-2">Model</th>
                  <th className="pb-2 text-right">Generations</th>
                  <th className="pb-2 text-right">Est. unit</th>
                  <th className="pb-2 text-right">Est. total</th>
                </tr>
              </thead>
              <tbody>
                {directRows.map((r) => (
                  <tr key={r.model} className="border-t border-border/50">
                    <td className="py-1.5 text-fg">{r.model}</td>
                    <td className="py-1.5 text-right tabular-nums text-fg-muted">{r.count}</td>
                    <td className="py-1.5 text-right tabular-nums text-fg-subtle">{usd(directUnitEst(r.model))}</td>
                    <td className="py-1.5 text-right tabular-nums text-brand">~{usd(r.est)}</td>
                  </tr>
                ))}
                {heygenCount > 0 && (
                  <tr className="border-t border-border/50">
                    <td className="py-1.5 text-fg">HeyGen renders (billed in credits)</td>
                    <td className="py-1.5 text-right tabular-nums text-fg-muted">{heygenCount}</td>
                    <td className="py-1.5 text-right text-fg-subtle">credits</td>
                    <td className="py-1.5 text-right text-fg-subtle">-</td>
                  </tr>
                )}
              </tbody>
            </table>
          )}
          <div className="text-[10px] text-fg-subtle mt-2">Unit prices are ESTIMATES for corp-key billing control; actual vendor invoices may differ. fal-billed models are tracked precisely in the totals above.</div>
        </div>

        {/* By user */}
        <h2 className="text-[11px] uppercase tracking-wider text-fg-subtle mb-2">By user</h2>
        <div className="border border-border rounded-lg overflow-x-auto mb-8">
          <table className="w-full text-[12px]">
            <thead className="bg-bg-card text-fg-subtle text-[10px] uppercase tracking-wider">
              <tr>
                <Th>User</Th>
                <Th right>Runs</Th>
                <Th right>Done</Th>
                <Th right>Errors</Th>
                <Th right>Cost</Th>
                <Th>Role</Th>
                <Th right>Last active</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-border/60 hover:bg-bg-card/40">
                  <td className="px-3 py-2.5">
                    <Link href={`/admin/users/${r.id}`} className="group">
                      <div className="flex items-center gap-2">
                        <span className="text-fg group-hover:text-brand transition">{r.name || r.email}</span>
                      </div>
                      {r.name && <div className="text-fg-subtle text-[10px]">{r.email}</div>}
                    </Link>
                  </td>
                  <Td right>{r.runs}</Td>
                  <Td right>{r.done}</Td>
                  <Td right className={r.errors > 0 ? "text-red-400" : undefined}>
                    {r.errors}
                  </Td>
                  <Td right>{usd(r.cost)}</Td>
                  <td className="px-3 py-2.5">
                    <RoleControl userId={r.id} role={r.role} isSelf={r.id === admin.id} />
                  </td>
                  <Td right>{r.lastSeenAt ? new Date(r.lastSeenAt).toLocaleDateString() : "—"}</Td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-3 py-6 text-center text-fg-subtle">
                    No users.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* By model */}
        <h2 className="text-[11px] uppercase tracking-wider text-fg-subtle mb-2">By model</h2>
        <div className="border border-border rounded-lg overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead className="bg-bg-card text-fg-subtle text-[10px] uppercase tracking-wider">
              <tr>
                <Th>Model</Th>
                <Th right>Generations</Th>
                <Th right>Cost</Th>
              </tr>
            </thead>
            <tbody>
              {modelAgg.map((m, i) => (
                <tr key={i} className="border-t border-border/60">
                  <Td>{m.model || "—"}</Td>
                  <Td right>{m._count._all}</Td>
                  <Td right>{usd(m._sum.costUsd ?? 0)}</Td>
                </tr>
              ))}
              {modelAgg.length === 0 && (
                <tr>
                  <td colSpan={3} className="px-3 py-6 text-center text-fg-subtle">
                    No data in range.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </main>
    </div>
  );
}

function Card({ label, value }: { label: string; value: string }) {
  return (
    <div className="surface p-4">
      <div className="text-[10px] uppercase tracking-wider text-fg-subtle">{label}</div>
      <div className="font-display text-2xl mt-1">{value}</div>
    </div>
  );
}

function Th({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return <th className={`px-3 py-2 font-medium ${right ? "text-right" : "text-left"}`}>{children}</th>;
}

function Td({
  children,
  right,
  className,
}: {
  children: React.ReactNode;
  right?: boolean;
  className?: string;
}) {
  return (
    <td className={`px-3 py-2.5 ${right ? "text-right tabular-nums" : ""} ${className ?? ""}`}>
      {children}
    </td>
  );
}

// Role badge + a one-click toggle (admin ⇄ member) backed by the setUserRole
// server action. The current admin can't change their own role (isSelf), so
// the toggle renders as a static badge for that row.
function RoleControl({ userId, role, isSelf }: { userId: string; role: string; isSelf: boolean }) {
  const isAdmin = role === "admin";
  const badge = (
    <span
      className={`px-1.5 py-0.5 rounded text-[9px] uppercase tracking-wide ${
        isAdmin ? "bg-brand/15 text-brand" : "bg-bg-card text-fg-muted border border-border"
      }`}
    >
      {role}
    </span>
  );

  if (isSelf) {
    return <div className="flex items-center gap-2">{badge}<span className="text-fg-subtle text-[10px]">(you)</span></div>;
  }

  return (
    <form action={setUserRole} className="flex items-center gap-2">
      {badge}
      <input type="hidden" name="userId" value={userId} />
      <input type="hidden" name="role" value={isAdmin ? "member" : "admin"} />
      <button
        type="submit"
        className="px-2 py-0.5 rounded border border-border text-fg-muted hover:text-fg hover:border-border-strong text-[10px] transition"
      >
        {isAdmin ? "Make member" : "Make admin"}
      </button>
    </form>
  );
}
