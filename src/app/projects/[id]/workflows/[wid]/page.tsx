import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import Canvas from "@/components/canvas/Canvas";
import { EMPTY_GRAPH, type Graph } from "@/lib/canvas/types";
import { resignGraphUrls } from "@/lib/storage";

export default async function WorkflowPage({
  params,
}: {
  params: Promise<{ id: string; wid: string }>;
}) {
  const { id, wid } = await params;
  await requireUser();

  const workflow = await prisma.workflow.findUnique({
    where: { id: wid },
    include: {
      project: {
        select: { id: true, name: true, brandId: true, brand: { select: { slug: true } } },
      },
    },
  });

  if (!workflow || workflow.projectId !== id) notFound();

  // Total actually spent across the whole project (all its workflows' runs).
  const spentAgg = await prisma.run.aggregate({
    _sum: { totalCostUsd: true },
    where: { workflow: { projectId: id } },
  });
  const projectSpentUsd = spentAgg._sum.totalCostUsd ?? 0;

  // If there's already a Run in flight for this workflow (because the user
  // started a generation, navigated away, and just came back), grab it.
  // Canvas will use it to immediately paint spinners on the right nodes
  // and resume polling — instead of showing them as idle.
  const activeRun = await prisma.run.findFirst({
    where: {
      workflowId: workflow.id,
      status: { in: ["pending", "running"] },
    },
    orderBy: { startedAt: "desc" },
    include: {
      steps: {
        select: {
          nodeId: true,
          status: true,
          outputData: true,
          errorMessage: true,
        },
      },
    },
  });

  const initialActiveRun = activeRun
    ? {
        runId: activeRun.id,
        startedAt: activeRun.startedAt.toISOString(),
        steps: activeRun.steps.map((s: (typeof activeRun.steps)[number]) => ({
          nodeId: s.nodeId,
          status: s.status as "pending" | "running" | "done" | "error",
          outputData: s.outputData as Record<string, unknown> | null,
          errorMessage: s.errorMessage,
        })),
      }
    : null;

  // Parse stored graph safely
  let graph: Graph = EMPTY_GRAPH;
  try {
    const stored = workflow.graph as unknown as { nodes?: unknown; edges?: unknown };
  // Old graphs carry expired signed URLs in outputs/results/history/uploads -
  // refresh them server-side so previews in old projects just work.
  await resignGraphUrls(stored);
    if (
      stored &&
      typeof stored === "object" &&
      Array.isArray(stored.nodes) &&
      Array.isArray(stored.edges)
    ) {
      graph = stored as unknown as Graph;
    }
  } catch {
    graph = EMPTY_GRAPH;
  }

  return (
    <div className="h-screen w-screen overflow-hidden bg-bg">
      <Canvas
        workflowId={workflow.id}
        workflowName={workflow.name}
        workflowMeta={{
          brandId: workflow.project.brandId,
          brandSlug: workflow.project.brand?.slug ?? null,
          projectId: workflow.project.id,
        }}
        initialGraph={graph}
        initialActiveRun={initialActiveRun}
        projectSpentUsd={projectSpentUsd}
      />
    </div>
  );
}
