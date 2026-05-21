import { notFound } from "next/navigation";
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import TopNav from "@/components/TopNav";
import { ChevronLeft, CheckCircle2, XCircle, Clock, Activity } from "lucide-react";
import { relativeTime } from "@/lib/format";

export default async function RunsPage({
  params,
}: {
  params: Promise<{ id: string; wid: string }>;
}) {
  await requireUser();
  const { id, wid } = await params;

  const workflow = await prisma.workflow.findUnique({
    where: { id: wid },
    include: { project: true },
  });
  if (!workflow) notFound();

  const runs = await prisma.run.findMany({
    where: { workflowId: wid },
    orderBy: { startedAt: "desc" },
    take: 100,
    include: {
      trigger: { select: { name: true, email: true } },
      _count: { select: { steps: true } },
    },
  });

  return (
    <div className="min-h-screen bg-bg text-fg">
      <TopNav />
      <main className="max-w-4xl mx-auto px-6 py-8">
        <Link
          href={`/projects/${id}/workflows/${wid}`}
          className="inline-flex items-center gap-1.5 text-[12px] text-fg-muted hover:text-fg mb-3"
        >
          <ChevronLeft size={12} />
          Back to canvas
        </Link>

        <div className="mb-6">
          <h1 className="text-2xl font-medium">Run history</h1>
          <p className="text-[13px] text-fg-muted mt-1">{workflow.name}</p>
        </div>

        {runs.length === 0 ? (
          <div className="text-center py-16 text-fg-subtle text-[13px]">
            No runs yet. Hit “Run all” on the canvas to start one.
          </div>
        ) : (
          <div className="border border-border rounded-lg overflow-hidden">
            {runs.map((r: typeof runs[number]) => (
              <Link
                key={r.id}
                href={`/projects/${id}/workflows/${wid}/runs/${r.id}`}
                className="flex items-center gap-3 px-4 py-3 hover:bg-bg-hover border-b border-border last:border-0"
              >
                <StatusIcon status={r.status} />
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] text-fg">
                    {r._count.steps} step{r._count.steps !== 1 ? "s" : ""} ·{" "}
                    {r.trigger.name ?? r.trigger.email}
                  </div>
                  <div className="text-[11px] text-fg-muted">
                    {relativeTime(r.startedAt)}
                    {r.finishedAt && r.startedAt && (
                      <>
                        {" · "}
                        {Math.round((r.finishedAt.getTime() - r.startedAt.getTime()) / 1000)}s
                      </>
                    )}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-[12px] text-fg-muted">{r.status}</div>
                  <div className="text-[11px] text-fg-subtle">${r.totalCostUsd.toFixed(3)}</div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

function StatusIcon({ status }: { status: string }) {
  if (status === "running" || status === "pending")
    return <Activity size={14} className="text-amber-500 animate-pulse" />;
  if (status === "done") return <CheckCircle2 size={14} className="text-emerald-500" />;
  if (status === "error") return <XCircle size={14} className="text-red-500" />;
  return <Clock size={14} className="text-fg-subtle" />;
}
