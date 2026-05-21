import { notFound } from "next/navigation";
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import TopNav from "@/components/TopNav";
import { ChevronLeft, CheckCircle2, XCircle, Clock, Activity } from "lucide-react";
import { NODE_TYPES } from "@/lib/canvas/types";

export default async function RunDetailPage({
  params,
}: {
  params: Promise<{ id: string; wid: string; rid: string }>;
}) {
  await requireUser();
  const { id, wid, rid } = await params;

  const run = await prisma.run.findUnique({
    where: { id: rid },
    include: {
      workflow: { select: { name: true } },
      trigger: { select: { name: true, email: true } },
      steps: {
        orderBy: { startedAt: "asc" },
        include: { assets: true },
      },
    },
  });
  if (!run) notFound();

  return (
    <div className="min-h-screen bg-bg text-fg">
      <TopNav />
      <main className="max-w-4xl mx-auto px-6 py-8">
        <Link
          href={`/projects/${id}/workflows/${wid}/runs`}
          className="inline-flex items-center gap-1.5 text-[12px] text-fg-muted hover:text-fg mb-3"
        >
          <ChevronLeft size={12} />
          All runs
        </Link>

        <div className="mb-6 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-medium">{run.workflow.name}</h1>
            <p className="text-[12px] text-fg-muted mt-1">
              Run by {run.trigger.name ?? run.trigger.email} ·{" "}
              {new Date(run.startedAt).toLocaleString()}
            </p>
          </div>
          <div className="text-right">
            <div className="text-[12px] text-fg-muted">{run.status}</div>
            <div className="text-[14px] font-medium tabular-nums">
              ${run.totalCostUsd.toFixed(3)}
            </div>
            {run.finishedAt && (
              <div className="text-[11px] text-fg-subtle">
                {Math.round((run.finishedAt.getTime() - run.startedAt.getTime()) / 1000)}s total
              </div>
            )}
          </div>
        </div>

        {run.errorMessage && (
          <div className="mb-6 rounded-md bg-red-500/10 border border-red-500/30 text-red-600 dark:text-red-400 text-[12px] p-3">
            {run.errorMessage}
          </div>
        )}

        <div className="space-y-2">
          {run.steps.map((s: typeof run.steps[number]) => {
            const def = NODE_TYPES[s.nodeType];
            const dur =
              s.finishedAt && s.startedAt
                ? Math.round((s.finishedAt.getTime() - s.startedAt.getTime()) / 1000)
                : null;
            return (
              <div key={s.id} className="rounded-md border border-border bg-bg-card overflow-hidden">
                <div className="px-4 py-2.5 flex items-center gap-3 border-b border-border">
                  <StatusIcon status={s.status} />
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] text-fg">{def?.name ?? s.nodeType}</div>
                    <div className="text-[11px] text-fg-muted">
                      {s.model ?? "—"}
                      {dur !== null && ` · ${dur}s`}
                    </div>
                  </div>
                  <div className="text-[12px] text-fg-muted tabular-nums">${s.costUsd.toFixed(3)}</div>
                </div>
                {s.errorMessage && (
                  <div className="px-4 py-2 text-[11px] text-red-500 bg-red-500/5 border-b border-red-500/20">
                    {s.errorMessage}
                  </div>
                )}
                {s.assets.length > 0 && (
                  <div className="p-3 grid grid-cols-3 gap-2">
                    {s.assets.map((a: typeof s.assets[number]) => (
                      <a
                        key={a.id}
                        href={a.cdnUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="block rounded-md overflow-hidden bg-bg-subtle border border-border hover:border-border-strong"
                      >
                        {a.kind === "image" && (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={a.cdnUrl} alt="" className="w-full h-32 object-cover" />
                        )}
                        {a.kind === "video" && <video src={a.cdnUrl} className="w-full h-32 object-cover" muted />}
                        {a.kind === "audio" && (
                          <div className="p-3">
                            <audio src={a.cdnUrl} controls className="w-full" />
                          </div>
                        )}
                        {a.kind === "text" && (
                          <div className="p-3 text-[10px] text-fg-muted">Text asset</div>
                        )}
                      </a>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </main>
    </div>
  );
}

function StatusIcon({ status }: { status: string }) {
  if (status === "running" || status === "pending")
    return <Activity size={13} className="text-amber-500 animate-pulse" />;
  if (status === "done") return <CheckCircle2 size={13} className="text-emerald-500" />;
  if (status === "error") return <XCircle size={13} className="text-red-500" />;
  return <Clock size={13} className="text-fg-subtle" />;
}
