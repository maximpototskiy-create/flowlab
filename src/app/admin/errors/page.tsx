// src/app/admin/errors/page.tsx
// Admin-only generation error log: every failed run step across all users,
// newest first, with a top-patterns summary to spot systemic issues (expired
// keys, model refusals, endpoint schema drift) before testers report them.
import Link from "next/link";
import TopNav from "@/components/TopNav";
import { requireAdmin } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RANGES = [
  { key: "1", label: "24 hours" },
  { key: "7", label: "7 days" },
  { key: "30", label: "30 days" },
];

type ErrRow = {
  id: string;
  nodeType: string;
  model: string | null;
  errorMessage: string | null;
  startedAt: Date;
  run: {
    id: string;
    triggeredBy: string;
    trigger: { email: string; name: string | null };
    workflow: { id: string; projectId: string; name: string } | null;
  };
};

// Normalise an error message into a grouping key: strip ids/urls/numbers so
// the same failure mode groups together.
function patternOf(msg: string): string {
  return msg
    .replace(/https?:\/\/\S+/g, "<url>")
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, "<id>")
    .replace(/\d+/g, "<n>")
    .slice(0, 140);
}

export default async function AdminErrorsPage({
  searchParams,
}: {
  searchParams?: Promise<{ range?: string }>;
}) {
  await requireAdmin();
  const sp = (await searchParams) ?? {};
  const range = sp.range === "1" || sp.range === "30" ? sp.range : "7";
  const since = new Date(Date.now() - Number(range) * 86_400_000);

  const errors = (await prisma.runStep.findMany({
    where: { status: "error", startedAt: { gte: since } },
    orderBy: { startedAt: "desc" },
    take: 200,
    select: {
      id: true,
      nodeType: true,
      model: true,
      errorMessage: true,
      startedAt: true,
      run: {
        select: {
          id: true,
          triggeredBy: true,
          trigger: { select: { email: true, name: true } },
          workflow: { select: { id: true, projectId: true, name: true } },
        },
      },
    },
  })) as unknown as ErrRow[];

  // Top failure patterns
  const patterns = new Map<string, number>();
  for (const e of errors) {
    const k = patternOf(e.errorMessage ?? "(no message)");
    patterns.set(k, (patterns.get(k) ?? 0) + 1);
  }
  const topPatterns = [...patterns.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);

  return (
    <div className="min-h-screen bg-bg">
      <TopNav activeNav="admin" />
      <main className="max-w-7xl mx-auto px-6 lg:px-10 py-8">
        <div className="flex items-center justify-between flex-wrap gap-3 mb-6">
          <div>
            <Link href="/admin" className="text-fg-muted hover:text-fg text-[11px] uppercase tracking-wider">
              &larr; Back to usage
            </Link>
            <h1 className="font-display text-3xl mt-2">Generation errors</h1>
            <p className="text-fg-muted text-sm mt-1">
              {errors.length}{errors.length === 200 ? "+" : ""} failed steps in the selected period.
            </p>
          </div>
          <div className="flex gap-1.5">
            {RANGES.map((r) => (
              <Link key={r.key} href={`/admin/errors?range=${r.key}`}
                className={`px-3 py-1.5 rounded-md border text-[11px] transition ${range === r.key ? "border-brand text-brand bg-brand/10" : "border-border text-fg-muted hover:text-fg"}`}>
                {r.label}
              </Link>
            ))}
          </div>
        </div>

        {topPatterns.length > 0 && (
          <div className="surface p-4 mb-6">
            <h2 className="text-[11px] uppercase tracking-wider text-fg-subtle mb-3">Top failure patterns</h2>
            <div className="space-y-1.5">
              {topPatterns.map(([pat, count]) => (
                <div key={pat} className="flex items-start gap-3 text-[12px]">
                  <span className="shrink-0 min-w-[36px] text-right tabular-nums text-brand">{count}&times;</span>
                  <span className="text-fg-muted font-mono text-[11px] leading-snug break-all">{pat}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {errors.length === 0 ? (
          <div className="border border-dashed border-border-strong rounded-lg py-16 text-center text-fg-subtle text-sm">
            No generation errors in this period.
          </div>
        ) : (
          <div className="space-y-2">
            {errors.map((e) => (
              <div key={e.id} className="border border-border rounded-lg p-3">
                <div className="flex items-center justify-between flex-wrap gap-2 mb-1.5">
                  <div className="flex items-center gap-2 text-[12px] min-w-0">
                    <span className="px-1.5 py-0.5 rounded bg-red-500/15 text-red-400 text-[10px] uppercase tracking-wide shrink-0">{e.nodeType}</span>
                    {e.model && <span className="text-fg-subtle text-[11px] truncate">{e.model}</span>}
                  </div>
                  <div className="flex items-center gap-3 text-[11px] text-fg-subtle shrink-0">
                    <Link href={`/admin/users/${e.run.triggeredBy}`} className="hover:text-brand">
                      {e.run.trigger.name || e.run.trigger.email}
                    </Link>
                    {e.run.workflow && (
                      <Link href={`/projects/${e.run.workflow.projectId}/workflows/${e.run.workflow.id}`} className="hover:text-brand truncate max-w-[200px]">
                        {e.run.workflow.name}
                      </Link>
                    )}
                    <span className="tabular-nums">{new Date(e.startedAt).toLocaleString()}</span>
                  </div>
                </div>
                <div className="text-[11px] font-mono text-fg-muted leading-snug break-all whitespace-pre-wrap max-h-24 overflow-y-auto">
                  {e.errorMessage ?? "(no message)"}
                </div>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
