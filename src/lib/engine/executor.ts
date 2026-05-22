// Workflow execution engine.
// - Topologically sorts nodes
// - Runs independent branches in parallel
// - Sequential when dependencies require it
// - Updates DB run/run_steps as it goes

import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { runNode, type RunnerContext, type RunnerResult } from "./runners";
import { kindFromMime } from "@/lib/storage";
import type { Graph, GraphNode } from "@/lib/canvas/types";
import { NODE_TYPES } from "@/lib/canvas/types";

type NodeStatus = "pending" | "running" | "done" | "error" | "skipped";

type ExecState = {
  graph: Graph;
  outputs: Map<string, Record<string, unknown>>;
  status: Map<string, NodeStatus>;
  errors: Map<string, string>;
  results: Map<string, { value: string; mime?: string }[]>;
  costByNode: Map<string, number>;
  durationByNode: Map<string, number>;
  runId: string;
  ctx: RunnerContext;
  /** Only execute these nodes (subset). null = all nodes */
  scope: Set<string> | null;
};

/** Topological sort. Throws on cycles. */
export function topoSort(graph: Graph, scope?: Set<string>): string[] {
  const nodes = scope ? graph.nodes.filter((n) => scope.has(n.id)) : graph.nodes;
  const nodeIds = new Set(nodes.map((n) => n.id));
  const inDeg = new Map<string, number>();
  for (const n of nodes) inDeg.set(n.id, 0);
  const adj = new Map<string, string[]>();
  for (const n of nodes) adj.set(n.id, []);

  for (const e of graph.edges) {
    if (!nodeIds.has(e.from.nodeId) || !nodeIds.has(e.to.nodeId)) continue;
    adj.get(e.from.nodeId)!.push(e.to.nodeId);
    inDeg.set(e.to.nodeId, (inDeg.get(e.to.nodeId) ?? 0) + 1);
  }

  const queue: string[] = [];
  for (const [id, d] of inDeg.entries()) if (d === 0) queue.push(id);
  const out: string[] = [];

  while (queue.length) {
    const id = queue.shift()!;
    out.push(id);
    for (const next of adj.get(id) ?? []) {
      const d = (inDeg.get(next) ?? 1) - 1;
      inDeg.set(next, d);
      if (d === 0) queue.push(next);
    }
  }
  if (out.length !== nodes.length) throw new Error("Graph contains a cycle");
  return out;
}

/** Group topologically-sorted nodes by depth — nodes in same layer can run in parallel */
export function layerByDepth(graph: Graph, order: string[]): string[][] {
  const depth = new Map<string, number>();
  for (const id of order) {
    const incoming = graph.edges.filter((e) => e.to.nodeId === id);
    let d = 0;
    for (const e of incoming) {
      d = Math.max(d, (depth.get(e.from.nodeId) ?? 0) + 1);
    }
    depth.set(id, d);
  }
  const layers: string[][] = [];
  for (const id of order) {
    const d = depth.get(id) ?? 0;
    if (!layers[d]) layers[d] = [];
    layers[d].push(id);
  }
  return layers;
}

/** Resolve a node's input map from upstream outputs + edge connections.
 *
 * For regular ports: inputs[port] = upstream value (single).
 * For multi-ports (Port.multi === true): inputs[port] = array of values,
 * collected from all incoming edges in edge-order. Undefined upstream
 * outputs (parent failed or skipped) are filtered out, so the runner can
 * trust that the array contains only real, usable values.
 */
function resolveInputs(graph: Graph, node: GraphNode, outputs: Map<string, Record<string, unknown>>) {
  const inputs: Record<string, unknown> = {};
  const def = NODE_TYPES[node.type];
  // Build a set of port names that are declared multi on this node type.
  const multiPortNames = new Set<string>(
    (def?.inputs ?? []).filter((p) => p.multi).map((p) => p.name),
  );

  for (const edge of graph.edges) {
    if (edge.to.nodeId !== node.id) continue;
    const upstream = outputs.get(edge.from.nodeId);
    if (!upstream) continue;
    const value = upstream[edge.from.port];
    if (value === undefined || value === null) continue;

    if (multiPortNames.has(edge.to.port)) {
      const arr = (inputs[edge.to.port] as unknown[] | undefined) ?? [];
      arr.push(value);
      inputs[edge.to.port] = arr;
    } else {
      inputs[edge.to.port] = value;
    }
  }

  // Initialise empty arrays for declared multi-ports that received no edges,
  // so runners can do `(inputs.images as string[]).length` without null checks.
  for (const name of multiPortNames) {
    if (inputs[name] === undefined) inputs[name] = [];
  }

  return inputs;
}

/** Find all ancestor nodes of `targetId` (for subgraph execution) */
export function ancestorsOf(graph: Graph, targetId: string): Set<string> {
  const need = new Set<string>();
  function visit(id: string) {
    if (need.has(id)) return;
    need.add(id);
    for (const e of graph.edges) if (e.to.nodeId === id) visit(e.from.nodeId);
  }
  visit(targetId);
  return need;
}

/** Execute a single node and persist its run_step */
async function executeOne(
  node: GraphNode,
  state: ExecState,
): Promise<void> {
  state.status.set(node.id, "running");
  const inputs = resolveInputs(state.graph, node, state.outputs);

  const runStep = await prisma.runStep.create({
    data: {
      runId: state.runId,
      nodeId: node.id,
      nodeType: node.type,
      model: (node.config?.model as string) ?? null,
      status: "running",
      inputParams: node.config as never,
    },
  });

  try {
    const result: RunnerResult = await runNode(node.type, node.config, inputs, {
      ...state.ctx,
      runStepId: runStep.id,
    });

    state.outputs.set(node.id, result.outputs);
    if (result.results) state.results.set(node.id, result.results);
    state.costByNode.set(node.id, result.costUsd);
    state.durationByNode.set(node.id, result.durationMs);
    state.status.set(node.id, "done");

    // Persist asset rows for any URLs in outputs
    const assetEntries: { cdnUrl: string; kind: "image" | "video" | "audio" | "text" }[] = [];
    for (const [port, value] of Object.entries(result.outputs)) {
      if (typeof value === "string" && value.startsWith("http")) {
        const kind = inferKindFromUrl(value, port);
        await prisma.asset.create({
          data: {
            brandId: state.ctx.brandId ?? null,
            projectId: state.ctx.projectId ?? null,
            storagePath: "", // we store the cdnUrl which is already signed
            cdnUrl: value,
            kind,
            source: "generated",
            model: (node.config?.model as string) ?? null,
            prompt: (node.config?.instructions as string) ?? null,
            runStepId: runStep.id,
          },
        });
        assetEntries.push({ cdnUrl: value, kind });
      }
    }

    await prisma.runStep.update({
      where: { id: runStep.id },
      data: {
        status: "done",
        finishedAt: new Date(),
        costUsd: result.costUsd,
        outputData: result.outputs as never,
      },
    });

    // ─────────────────────────────────────────────────────────────────────
    // CRITICAL: persist outputs/results into workflow.graph itself.
    //
    // Without this, generated content only lives in client React state via
    // polling. If the user navigates to another workflow / closes the tab /
    // refreshes mid-run, the polling stops and outputs never make it into
    // the saved graph. The user comes back and sees empty nodes even though
    // the assets exist in Supabase.
    //
    // We do a read-modify-write inside a transaction, patching ONLY this
    // node's outputs/results. Position, config, edges and other nodes are
    // preserved exactly as they were. This means a background run can
    // safely complete while the user is editing other nodes — no overwrites.
    // ─────────────────────────────────────────────────────────────────────
    if (state.ctx.workflowId) {
      try {
        await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
          const wf = await tx.workflow.findUnique({
            where: { id: state.ctx.workflowId! },
            select: { graph: true },
          });
          if (!wf?.graph) return;
          const g = wf.graph as { nodes?: unknown; edges?: unknown };
          if (!Array.isArray(g.nodes)) return;
          const idx = (g.nodes as Array<{ id?: string }>).findIndex(
            (n) => n && typeof n === "object" && n.id === node.id,
          );
          if (idx < 0) return;
          const nodesArr = [...(g.nodes as Array<Record<string, unknown>>)];
          nodesArr[idx] = {
            ...nodesArr[idx],
            outputs: result.outputs,
            // Mirrors what client polling builds: only set results when there
            // are 2+ assets (single-asset results go via outputs.<port>).
            ...(assetEntries.length > 1
              ? { results: assetEntries.map((a) => ({ value: a.cdnUrl, mime: a.kind })) }
              : { results: undefined }),
          };
          await tx.workflow.update({
            where: { id: state.ctx.workflowId! },
            data: { graph: { ...g, nodes: nodesArr } as never },
          });
        });
      } catch (e) {
        // Non-fatal — the RunStep is already saved with outputData, so the
        // client polling will still pick it up. Log so we can investigate.
        console.error("[executor] failed to persist node outputs into workflow.graph:", e);
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    state.status.set(node.id, "error");
    state.errors.set(node.id, msg);
    await prisma.runStep.update({
      where: { id: runStep.id },
      data: { status: "error", finishedAt: new Date(), errorMessage: msg },
    });
    throw err;
  }
}

function inferKindFromUrl(url: string, port: string): "image" | "video" | "audio" | "text" {
  if (port.toLowerCase().includes("image") || port === "character" || port === "composed") return "image";
  if (port.toLowerCase().includes("video") || port === "section") return "video";
  if (port.toLowerCase().includes("audio")) return "audio";
  // Fallback: extension
  const ext = url.split(".").pop()?.toLowerCase().split("?")[0] ?? "";
  if (["mp4", "webm", "mov"].includes(ext)) return "video";
  if (["mp3", "wav", "m4a", "ogg"].includes(ext)) return "audio";
  if (["jpg", "jpeg", "png", "webp", "gif"].includes(ext)) return "image";
  return "text";
}

/** Execute a whole graph (or scope) — parallel within depth layers */
export async function executeGraph(
  graph: Graph,
  ctx: RunnerContext,
  opts: { scope?: Set<string>; runId: string; scopeNodeId?: string },
): Promise<{
  outputs: Map<string, Record<string, unknown>>;
  errors: Map<string, string>;
  totalCost: number;
  results: Map<string, { value: string; mime?: string }[]>;
  durations: Map<string, number>;
}> {
  const state: ExecState = {
    graph,
    outputs: new Map(),
    status: new Map(),
    errors: new Map(),
    results: new Map(),
    costByNode: new Map(),
    durationByNode: new Map(),
    runId: opts.runId,
    ctx,
    scope: opts.scope ?? null,
  };

  // CACHING: when running a single-node scope (▶ on one node), reuse cached
  // outputs from upstream nodes that already have results — don't re-execute them.
  // Only the requested node + downstream nodes that depend on its NEW output are run.
  // When user hits "Run All" (no scopeNodeId), nothing is cached — full re-run.
  const isSubgraphRun = Boolean(opts.scopeNodeId);
  if (isSubgraphRun) {
    let cachedCount = 0;
    for (const node of graph.nodes) {
      // The scope node itself is always re-executed.
      if (node.id === opts.scopeNodeId) continue;
      const cached = (node as GraphNode & { outputs?: Record<string, unknown> }).outputs;
      if (cached && Object.keys(cached).length > 0) {
        state.outputs.set(node.id, cached);
        state.status.set(node.id, "done");
        cachedCount++;
      }
    }
    console.log(`[executor] subgraph run scope=${opts.scopeNodeId}, ${cachedCount} nodes have cached outputs`);
  }

  const order = topoSort(graph, opts.scope ?? undefined);
  const layers = layerByDepth(graph, order);

  for (const layer of layers) {
    if (!layer) continue;

    // Check if the run was cancelled between layers
    const fresh = await prisma.run.findUnique({ where: { id: opts.runId }, select: { status: true } });
    if (fresh?.status === "cancelled") {
      // Stop processing further layers
      return {
        outputs: state.outputs,
        errors: state.errors,
        totalCost: [...state.costByNode.values()].reduce((a, b) => a + b, 0),
        results: state.results,
        durations: state.durationByNode,
      };
    }

    // Parallel within layer — but skip already-cached nodes
    await Promise.all(
      layer.map(async (nodeId) => {
        if (state.status.get(nodeId) === "done") {
          console.log(`[executor] skip ${nodeId} (cached)`);
          return; // cached
        }
        const node = graph.nodes.find((n) => n.id === nodeId);
        if (!node) return;
        console.log(`[executor] execute ${nodeId} (${node.type})`);
        try {
          await executeOne(node, state);
        } catch {
          // already recorded
        }
      }),
    );
    // If any failed in this layer, downstream layers won't have inputs — they'll fail naturally
  }

  const totalCost = [...state.costByNode.values()].reduce((a, b) => a + b, 0);
  return {
    outputs: state.outputs,
    errors: state.errors,
    totalCost,
    results: state.results,
    durations: state.durationByNode,
  };
}
