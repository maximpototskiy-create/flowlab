import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import Canvas from "@/components/canvas/Canvas";
import { EMPTY_GRAPH, type Graph } from "@/lib/canvas/types";

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

  // Parse stored graph safely
  let graph: Graph = EMPTY_GRAPH;
  try {
    const stored = workflow.graph as unknown as { nodes?: unknown; edges?: unknown };
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
      />
    </div>
  );
}
