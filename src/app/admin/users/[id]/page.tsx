// src/app/admin/users/[id]/page.tsx
// Admin-only per-user drill-down: totals + that user's recent runs with their
// generated assets. Gated by requireAdmin().
import Link from "next/link";
import Image from "next/image";
import { notFound } from "next/navigation";
import TopNav from "@/components/TopNav";
import { requireAdmin } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { setUserRole } from "../../actions";
import { directUnitEst } from "@/lib/adminPricing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RUN_LIMIT = 50;

function usd(n: number) {
  return "$" + (n < 1 ? n.toFixed(4) : n.toFixed(2));
}

// next/image can only optimize hosts whitelisted in next.config.ts
// remotePatterns; anything else falls back to a plain <img>.
function canOptimize(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  return (
    host === "supabase.co" || host.endsWith(".supabase.co") ||
    host === "fal.media" || host.endsWith(".fal.media") ||
    host === "storage.googleapis.com"
  );
}

type UserRow = { id: string; email: string; name: string | null; role: string; lastSeenAt: Date | null; createdAt: Date };
type AggRow = { _count: { _all: number }; _sum: { totalCostUsd: number | null } };
type StatusAggRow = { status: string; _count: { _all: number } };
type AssetLite = { id: string; cdnUrl: string; kind: string };
type StepLite = { id: string; nodeType: string; model: string | null; status: string; assets: AssetLite[] };
type RunLite = {
  id: string;
  status: string;
  startedAt: Date;
  totalCostUsd: number;
  workflow: { id: string; projectId: string; name: string; project: { name: string; brand: { slug: string } | null } | null } | null;
  steps: StepLite[];
};
type ProjectLite = { id: string; name: string; updatedAt: Date; brand: { name: string; slug: string } | null; _count: { workflows: number } };
type WorkflowLite = { id: string; projectId: string; name: string; updatedAt: Date; project: { name: string } | null };
type GenLite = { id: string; cdnUrl: string; kind: string; model: string | null; createdAt: Date };

const USER_RANGES = [
  { key: "7", label: "7 days" },
  { key: "30", label: "30 days" },
  { key: "all", label: "All time" },
];

export default async function AdminUserPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams?: Promise<{ range?: string }> }) {
  const admin = await requireAdmin();
  const { id } = await params;
  const sp = (await searchParams) ?? {};
  const range = sp.range === "7" || sp.range === "30" ? sp.range : "all";
  const since = range === "all" ? undefined : new Date(Date.now() - Number(range) * 86_400_000);

  const user = (await prisma.user.findUnique({
    where: { id },
    select: { id: true, email: true, name: true, role: true, lastSeenAt: true, createdAt: true },
  })) as UserRow | null;
  if (!user) notFound();

  const [agg, statusAgg, runs] = (await Promise.all([
    prisma.run.aggregate({
      where: { triggeredBy: id, ...(since ? { startedAt: { gte: since } } : {}) },
      _count: { _all: true },
      _sum: { totalCostUsd: true },
    }),
    prisma.run.groupBy({
      by: ["status"],
      where: { triggeredBy: id, ...(since ? { startedAt: { gte: since } } : {}) },
      _count: { _all: true },
    }),
    prisma.run.findMany({
      where: { triggeredBy: id, ...(since ? { startedAt: { gte: since } } : {}) },
      orderBy: { startedAt: "desc" },
      take: RUN_LIMIT,
      select: {
        id: true,
        status: true,
        startedAt: true,
        totalCostUsd: true,
        workflow: {
          select: { id: true, projectId: true, name: true, project: { select: { name: true, brand: { select: { slug: true } } } } },
        },
        steps: {
          select: {
            id: true,
            nodeType: true,
            model: true,
            status: true,
            assets: { select: { id: true, cdnUrl: true, kind: true } },
          },
        },
      },
    }),
  ])) as unknown as [AggRow, StatusAggRow[], RunLite[]];

  // The user's own projects/workflows (for jumping straight into their work)
  // and a flat gallery of EVERYTHING they generated, newest first.
  const [projects, workflows, generations] = (await Promise.all([
    prisma.project.findMany({
      where: { createdBy: id, archivedAt: null },
      orderBy: { updatedAt: "desc" },
      select: { id: true, name: true, updatedAt: true, brand: { select: { name: true, slug: true } }, _count: { select: { workflows: true } } },
    }),
    prisma.workflow.findMany({
      where: { createdBy: id },
      orderBy: { updatedAt: "desc" },
      take: 100,
      select: { id: true, projectId: true, name: true, updatedAt: true, project: { select: { name: true } } },
    }),
    prisma.asset.findMany({
      where: { source: "generated", runStep: { run: { triggeredBy: id } }, ...(since ? { createdAt: { gte: since } } : {}) },
      orderBy: { createdAt: "desc" },
      take: 96,
      select: { id: true, cdnUrl: true, kind: true, model: true, createdAt: true },
    }),
  ])) as unknown as [ProjectLite[], WorkflowLite[], GenLite[]];

  // Direct (corp-key) generations by THIS user + HeyGen renders - real counts
  // with estimated potential price (their recorded costUsd is 0).
  const [directAgg, heygenCount] = (await Promise.all([
    prisma.asset.groupBy({
      by: ["model"],
      where: {
        source: "generated",
        runStep: { run: { triggeredBy: id } },
        OR: [{ model: { startsWith: "google/" } }, { model: { startsWith: "openai/" } }],
        ...(since ? { createdAt: { gte: since } } : {}),
      },
      _count: { _all: true },
    }),
    prisma.runStep.count({
      where: { nodeType: "heygenVideo", status: "done", run: { triggeredBy: id }, ...(since ? { startedAt: { gte: since } } : {}) },
    }),
  ])) as unknown as [{ model: string | null; _count: { _all: number } }[], number];
  const directRows = directAgg
    .filter((d) => d.model)
    .map((d) => ({ model: d.model!, count: d._count._all, est: d._count._all * directUnitEst(d.model!) }))
    .sort((a, b) => b.count - a.count);
  const directEstTotal = directRows.reduce((s, r) => s + r.est, 0);

  const totalRuns = agg._count._all;
  const totalCost = agg._sum.totalCostUsd ?? 0;
  const done = statusAgg.find((s) => s.status === "done")?._count._all ?? 0;
  const errors = statusAgg.find((s) => s.status === "error")?._count._all ?? 0;

  return (
    <div className="min-h-screen bg-bg">
      <TopNav activeNav="admin" />
      <main className="max-w-7xl mx-auto px-6 lg:px-10 py-8">
        <Link href="/admin" className="text-fg-muted hover:text-fg text-[11px] uppercase tracking-wider">
          ← Back to usage
        </Link>

        {/* Header */}
        <div className="flex items-start justify-between flex-wrap gap-3 mt-3 mb-6">
          <div>
            <h1 className="font-display text-3xl flex items-center gap-3">
              {user.name || user.email}
              <span
                className={`px-2 py-0.5 rounded text-[10px] uppercase tracking-wide ${
                  user.role === "admin" ? "bg-brand/15 text-brand" : "bg-bg-card text-fg-muted border border-border"
                }`}
              >
                {user.role}
              </span>
            </h1>
            <p className="text-fg-muted text-sm mt-1">{user.email}</p>
            <p className="text-fg-subtle text-[11px] mt-0.5">
              Joined {new Date(user.createdAt).toLocaleDateString()} · Last active{" "}
              {user.lastSeenAt ? new Date(user.lastSeenAt).toLocaleString() : "—"}
            </p>
          </div>

          {user.id !== admin.id && (
            <form action={setUserRole} className="flex items-center gap-2">
              <input type="hidden" name="userId" value={user.id} />
              <input type="hidden" name="role" value={user.role === "admin" ? "member" : "admin"} />
              <button
                type="submit"
                className="px-3 py-1.5 rounded-md border border-border text-fg-muted hover:text-fg hover:border-border-strong text-[11px] transition"
              >
                {user.role === "admin" ? "Revoke admin" : "Make admin"}
              </button>
            </form>
          )}
        </div>

        {/* Period */}
        <div className="flex gap-1.5 mb-4">
          {USER_RANGES.map((r) => (
            <Link key={r.key} href={`/admin/users/${id}?range=${r.key}`}
              className={`px-3 py-1.5 rounded-md border text-[11px] transition ${range === r.key ? "border-brand text-brand bg-brand/10" : "border-border text-fg-muted hover:text-fg"}`}>
              {r.label}
            </Link>
          ))}
        </div>

        {/* Totals */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-8">
          <Card label="Runs" value={String(totalRuns)} />
          <Card label="Cost (fal)" value={usd(totalCost)} />
          <Card label="Direct est." value={"~" + usd(directEstTotal)} />
          <Card label="Combined est." value={"~" + usd(totalCost + directEstTotal)} />
          <Card label="Done" value={String(done)} />
          <Card label="Errors" value={String(errors)} accent={errors > 0} />
        </div>

        {/* Direct generations - corp-key billing control */}
        {(directRows.length > 0 || heygenCount > 0) && (
          <div className="surface p-4 mb-8">
            <h2 className="text-[11px] uppercase tracking-wider text-fg-subtle mb-3">Direct generations (corp keys)</h2>
            <table className="w-full text-[12px]">
              <tbody>
                {directRows.map((r) => (
                  <tr key={r.model} className="border-t border-border/50 first:border-t-0">
                    <td className="py-1.5 text-fg">{r.model}</td>
                    <td className="py-1.5 text-right tabular-nums text-fg-muted">{r.count}</td>
                    <td className="py-1.5 text-right tabular-nums text-brand">~{usd(r.est)}</td>
                  </tr>
                ))}
                {heygenCount > 0 && (
                  <tr className="border-t border-border/50 first:border-t-0">
                    <td className="py-1.5 text-fg">HeyGen renders (credits)</td>
                    <td className="py-1.5 text-right tabular-nums text-fg-muted">{heygenCount}</td>
                    <td className="py-1.5 text-right text-fg-subtle">-</td>
                  </tr>
                )}
              </tbody>
            </table>
            <div className="text-[10px] text-fg-subtle mt-2">Estimated prices - billed on corporate keys, not included in the fal cost column.</div>
          </div>
        )}

        {/* Their projects and workflows — jump straight into their work */}
        {(projects.length > 0 || workflows.length > 0) && (
          <div className="grid md:grid-cols-2 gap-4 mb-8">
            <div className="surface p-4">
              <h2 className="text-[11px] uppercase tracking-wider text-fg-subtle mb-3">Projects created ({projects.length})</h2>
              {projects.length === 0 ? <div className="text-fg-subtle text-sm">None.</div> : (
                <div className="space-y-1 max-h-64 overflow-y-auto pr-1">
                  {projects.map((p) => (
                    <Link key={p.id} href={`/projects/${p.id}`} className="flex items-center justify-between gap-2 px-2 py-1.5 rounded hover:bg-bg-card text-[12px] group">
                      <span className="truncate text-fg group-hover:text-brand">{p.name}</span>
                      <span className="text-fg-subtle text-[10px] shrink-0">{p.brand?.name ? `${p.brand.name} · ` : ""}{p._count.workflows} wf</span>
                    </Link>
                  ))}
                </div>
              )}
            </div>
            <div className="surface p-4">
              <h2 className="text-[11px] uppercase tracking-wider text-fg-subtle mb-3">Workflows created ({workflows.length})</h2>
              {workflows.length === 0 ? <div className="text-fg-subtle text-sm">None.</div> : (
                <div className="space-y-1 max-h-64 overflow-y-auto pr-1">
                  {workflows.map((w) => (
                    <Link key={w.id} href={`/projects/${w.projectId}/workflows/${w.id}`} className="flex items-center justify-between gap-2 px-2 py-1.5 rounded hover:bg-bg-card text-[12px] group">
                      <span className="truncate text-fg group-hover:text-brand">{w.name}</span>
                      <span className="text-fg-subtle text-[10px] shrink-0">{w.project?.name ?? ""}</span>
                    </Link>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Everything they generated — flat gallery, newest first. Click opens
            the asset full size in a new tab. */}
        <h2 className="text-[11px] uppercase tracking-wider text-fg-subtle mb-3">Generations ({generations.length}{generations.length === 96 ? "+" : ""})</h2>
        {generations.length === 0 ? (
          <div className="border border-dashed border-border-strong rounded-lg py-8 text-center text-fg-subtle text-sm mb-8">No generations yet.</div>
        ) : (
          <div className="grid grid-cols-4 sm:grid-cols-6 lg:grid-cols-8 xl:grid-cols-12 gap-2 mb-8">
            {generations.map((g) => (
              <a key={g.id} href={g.cdnUrl} target="_blank" rel="noopener noreferrer"
                title={`${g.kind}${g.model ? ` · ${g.model}` : ""} · ${new Date(g.createdAt).toLocaleString()}`}
                className="block aspect-square rounded-md overflow-hidden hairline bg-bg-card hover:ring-2 hover:ring-brand transition">
                {g.kind === "image" ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={g.cdnUrl} alt="" loading="lazy" decoding="async" className="w-full h-full object-cover" />
                ) : g.kind === "video" ? (
                  <video src={g.cdnUrl} muted playsInline preload="metadata" className="w-full h-full object-cover" />
                ) : (
                  <span className="w-full h-full flex items-center justify-center text-fg-subtle text-[9px] uppercase">{g.kind}</span>
                )}
              </a>
            ))}
          </div>
        )}

        {/* Recent runs */}
        <h2 className="text-[11px] uppercase tracking-wider text-fg-subtle mb-3">
          Recent runs {totalRuns > RUN_LIMIT && <span className="text-fg-subtle">(latest {RUN_LIMIT})</span>}
        </h2>

        {runs.length === 0 ? (
          <div className="border border-dashed border-border-strong rounded-lg py-12 text-center text-fg-subtle text-sm">
            No runs yet.
          </div>
        ) : (
          <div className="space-y-3">
            {runs.map((run) => {
              const assets = run.steps.flatMap((s) => s.assets);
              return (
                <div key={run.id} className="border border-border rounded-lg p-4">
                  <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
                    <div className="min-w-0">
                      <div className="text-fg text-[13px] truncate">
                        {run.workflow ? (
                          <Link href={`/projects/${run.workflow.projectId}/workflows/${run.workflow.id}`} className="hover:text-brand hover:underline underline-offset-2">
                            {run.workflow.name}
                          </Link>
                        ) : "(workflow deleted)"}
                      </div>
                      <div className="text-fg-subtle text-[10px] truncate">
                        {[run.workflow?.project?.brand?.slug, run.workflow?.project?.name]
                          .filter(Boolean)
                          .join(" · ") || "—"}{" "}
                        · {new Date(run.startedAt).toLocaleString()}
                      </div>
                    </div>
                    <div className="flex items-center gap-3 text-[11px]">
                      <StatusChip status={run.status} />
                      <span className="text-fg-muted tabular-nums">{usd(run.totalCostUsd)}</span>
                      <span className="text-fg-subtle">{run.steps.length} steps</span>
                    </div>
                  </div>

                  {assets.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {assets.slice(0, 12).map((a) => (
                        <AssetThumb key={a.id} asset={a} />
                      ))}
                      {assets.length > 12 && (
                        <div className="w-16 h-16 rounded-md bg-bg-card border border-border flex items-center justify-center text-fg-subtle text-[10px]">
                          +{assets.length - 12}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}

function AssetThumb({ asset }: { asset: AssetLite }) {
  const isImage = asset.kind === "image" || (asset.kind === "text" && /\.(png|jpe?g|webp|gif)$/i.test(asset.cdnUrl.split("?")[0]));
  if (isImage) {
    if (canOptimize(asset.cdnUrl)) {
      return (
        <div className="relative w-16 h-16 r-sm overflow-hidden hairline bg-bg-card">
          <Image src={asset.cdnUrl} alt="" fill sizes="64px" className="object-cover" />
        </div>
      );
    }
    // eslint-disable-next-line @next/next/no-img-element
    return (
      <img
        src={asset.cdnUrl}
        alt=""
        className="w-16 h-16 r-sm object-cover hairline bg-bg-card"
        loading="lazy"
        decoding="async"
      />
    );
  }
  return (
    <div className="w-16 h-16 r-sm hairline bg-bg-card flex items-center justify-center text-fg-subtle text-[9px] uppercase tracking-wide">
      {asset.kind}
    </div>
  );
}

function StatusChip({ status }: { status: string }) {
  const map: Record<string, string> = {
    done: "bg-brand/15 text-brand",
    running: "bg-amber-500/15 text-amber-400",
    pending: "bg-amber-500/15 text-amber-400",
    error: "bg-red-500/15 text-red-400",
    cancelled: "bg-bg-card text-fg-muted border border-border",
  };
  return (
    <span className={`px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wide ${map[status] ?? "bg-bg-card text-fg-muted"}`}>
      {status}
    </span>
  );
}

function Card({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="surface p-4">
      <div className="text-[10px] uppercase tracking-wider text-fg-subtle">{label}</div>
      <div className={`font-display text-2xl mt-1 ${accent ? "text-red-400" : ""}`}>{value}</div>
    </div>
  );
}
