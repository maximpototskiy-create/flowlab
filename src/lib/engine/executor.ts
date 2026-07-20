// Workflow execution engine.
// - Topologically sorts nodes
// - Runs independent branches in parallel
// - Sequential when dependencies require it
// - Updates DB run/run_steps as it goes

import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { runNode, type RunnerContext, type RunnerResult } from "./runners";
import { falRealCost } from "@/lib/fal/client";
import { kindFromMime } from "@/lib/storage";
import type { Graph, GraphNode } from "@/lib/canvas/types";
import { NODE_TYPES } from "@/lib/canvas/types";

// Per-workflow in-process serialisation for graph persists. Parallel node
// completions (Promise.all within a layer) all read-modify-write the SAME
// workflow.graph row; serialising them here means each read sees the prior
// write (no lost node outputs) WITHOUT an interactive DB transaction.
// Interactive transactions over the Supabase transaction pooler can be left
// OPEN when the serverless instance is frozen/killed mid-run (the in-JS
// transaction-timeout timer never fires) — that held the workflow row lock for
// ~2 min and cascaded into connection-pool-exhaustion (P2024) 500s across the
// whole app. A single UPDATE statement can't be "left open", so this avoids it.
const graphPersistChain = new Map<string, Promise<unknown>>();
function withGraphLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = graphPersistChain.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  graphPersistChain.set(key, next.then(() => {}, () => {}));
  return next;
}

type NodeStatus = "pending" | "running" | "done" | "error" | "skipped";

// ─── Staleness signature (patch 319) ────────────────────────────────────────
// Hash of everything that determines a node's output: its type, its config
// (minus volatile "_"-prefixed UI keys) and the RESOLVED INPUT VALUES it
// consumed. Persisted next to outputs; on a subgraph run cached outputs are
// reused ONLY when the signature still matches — so editing a prompt,
// reconnecting an input or an upstream producing a new value all invalidate
// the cache instead of silently serving stale content.
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  const o = v as Record<string, unknown>;
  return "{" + Object.keys(o).sort().map((k) => JSON.stringify(k) + ":" + stableStringify(o[k])).join(",") + "}";
}

export function computeExecSig(node: GraphNode, inputs: Record<string, unknown>): string {
  const cfg: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node.config ?? {})) {
    if (k.startsWith("_")) continue; // UI-only keys (e.g. _selectedResultIdx affects DOWNSTREAM inputs, not this node)
    cfg[k] = v;
  }
  return createHash("sha1")
    .update(node.type + "|" + stableStringify(cfg) + "|" + stableStringify(inputs))
    .digest("hex");
}

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
function resolveInputs(
  graph: Graph,
  node: GraphNode,
  outputs: Map<string, Record<string, unknown>>,
  results: Map<string, { value: string; mime?: string }[]>,
) {
  const inputs: Record<string, unknown> = {};
  const def = NODE_TYPES[node.type];
  // Build a set of port names that are declared multi on this node type.
  const multiPortNames = new Set<string>(
    (def?.inputs ?? []).filter((p) => p.multi).map((p) => p.name),
  );

  for (const edge of graph.edges) {
    if (edge.to.nodeId !== node.id) continue;
    const upstreamNode = graph.nodes.find((n) => n.id === edge.from.nodeId) as
      | (GraphNode & { outputs?: Record<string, unknown>; results?: { value: string; mime?: string }[] })
      | undefined;
    let upstream = outputs.get(edge.from.nodeId);
    // Fallback to the graph snapshot's persisted outputs when the live run map
    // doesn't have this upstream (e.g. a ▶-on-node run where the upstream was
    // produced in a previous run and isn't part of this run's executed set).
    // Without this the input looks "empty" even though the upstream clearly
    // shows a result on the canvas — the source of the false
    // "Connect the … to the … port" errors.
    if (!upstream && upstreamNode?.outputs && Object.keys(upstreamNode.outputs).length > 0) {
      upstream = upstreamNode.outputs;
    }
    if (!upstream) continue;

    // Determine the value flowing through this edge. By default it's
    // upstream.outputs[port] (the first/representative URL for multi-result
    // nodes). BUT if the upstream node has a `_selectedResultIdx` in its
    // config AND it has a `results` array, prefer the user-selected URL.
    // This lets users click a thumbnail to choose which of N generated
    // images flows into the next node.
    let value = upstream[edge.from.port];
    if (
      upstreamNode?.results &&
      upstreamNode.results.length > 1 &&
      typeof upstreamNode.config?._selectedResultIdx === "number"
    ) {
      const idx = upstreamNode.config._selectedResultIdx as number;
      const picked = upstreamNode.results[idx];
      if (picked && typeof picked.value === "string") {
        // Only override if the output is a URL-like value matching the same
        // kind (image port → image URL). Text outputs are scalar and don't
        // have multi-result semantics in the same way.
        if (typeof value === "string" && value.startsWith("http")) {
          value = picked.value;
        }
      }
    }

    // Single-port fallback: some nodes (e.g. Brand Assets) keep their primary
    // value in `results[]` and may leave `outputs[port]` empty. If the port
    // value is missing, use the first available result so a single-port
    // destination (like Screen Replace's screen content) still receives it.
    if (value === undefined || value === null) {
      const live = results.get(edge.from.nodeId);
      const first = (live && live[0]) || (upstreamNode?.results && upstreamNode.results[0]);
      if (first && typeof first.value === "string") value = first.value;
    }

    if (value === undefined || value === null) continue;

    if (multiPortNames.has(edge.to.port)) {
      const arr = (inputs[edge.to.port] as unknown[] | undefined) ?? [];
      // Special case: Brand Assets node carries its full selection in
      // results[] because it produces multiple URLs from one port. Expand
      // all results into the multi-port instead of just the first.
      //
      // CRITICAL: we read from the live `results` Map (state.results from
      // executor), NOT from `upstreamNode.results` — the latter is the
      // graph snapshot, which is stale (was only populated on previous
      // saves and gets overwritten AFTER the run). Without this, the very
      // first execution of brandAssets node passed only one URL even
      // though the user selected several.
      if (upstreamNode?.type === "brandAssets") {
        // First try the live runtime map (current run's fresh results).
        const liveResults = results.get(upstreamNode.id);
        if (liveResults && liveResults.length > 0) {
          for (const r of liveResults) {
            if (r && typeof r.value === "string") arr.push(r.value);
          }
        } else if (Array.isArray(upstreamNode.results)) {
          // Fallback to snapshot for cached subgraph runs (when brandAssets
          // was already executed in a prior run and its outputs are cached).
          for (const r of upstreamNode.results) {
            if (r && typeof r.value === "string") arr.push(r.value);
          }
        } else {
          // Last resort — push the single value from outputs.
          arr.push(value);
        }
      } else {
        arr.push(value);
      }
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
  const inputs = resolveInputs(state.graph, node, state.outputs, state.results);

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
    // Real cost: re-price the step against fal's official unit prices (cached)
    // so the recorded spend matches fal billing. Direct Google/OpenAI (corp
    // keys) resolve to 0; unknown endpoints fall back to the local estimate.
    let cost = result.costUsd;
    const stepModel = (node.config?.model as string) ?? "";
    if (stepModel) {
      try {
        cost = await falRealCost(stepModel, {
          numImages: Number(node.config?.numResults ?? node.config?.numImages) || 1,
          duration: Number(node.config?.duration) || 1,
          resolution: String(node.config?.resolution ?? ""),
        });
      } catch { cost = result.costUsd; }
    }
    state.costByNode.set(node.id, cost);
    state.durationByNode.set(node.id, result.durationMs);
    state.status.set(node.id, "done");

    // Persist Asset rows. We use `result.results` (the full list of generated
    // URLs — e.g. all 4 images when num_results=4) and fall back to
    // `result.outputs` for nodes that only emit a single URL.
    //
    // BUG FIX: previously this only iterated `result.outputs`, where multi-
    // result imageGen stuffs ONLY the first URL ({ image: persisted[0] }).
    // So a 4-image generation created 1 Asset row, and on the next polling
    // tick the client saw `assets.length === 1` and wrote
    // `results: undefined` into node state — wiping the 4-URL `results` array
    // that the server-persist already saved into workflow.graph. The user
    // observed "only 1 image in the canvas". The storage files were there
    // (persistAsset copied them all), the graph had results=[4], but the
    // Asset table had 1 row, and the client polling clobbered the graph
    // results based on that 1-row truth.
    const assetEntries: { cdnUrl: string; kind: "image" | "video" | "audio" | "text" }[] = [];
    if (result.results && result.results.length > 0) {
      // Multi-result node — create one Asset row per URL.
      for (const r of result.results) {
        if (typeof r.value === "string" && r.value.startsWith("http")) {
          const kind = inferKindFromUrl(r.value, "result", node.type);
          await prisma.asset.create({
            data: {
              brandId: state.ctx.brandId ?? null,
              projectId: state.ctx.projectId ?? null,
              storagePath: "",
              cdnUrl: r.value,
              kind,
              source: "generated",
              model: (node.config?.model as string) ?? null,
              prompt: (node.config?.instructions as string) ?? null,
              runStepId: runStep.id,
            },
          });
          assetEntries.push({ cdnUrl: r.value, kind });
        }
      }
    } else {
      // Single-output node — fall back to result.outputs.
      for (const [port, value] of Object.entries(result.outputs)) {
        // Skip internal/non-media outputs (e.g. the cached track JSON URL) —
        // they must not become Asset rows, or the client turns a single-video
        // node into a 2-result preview.
        if (port === "track_url" || port.startsWith("_")) continue;
        if (typeof value === "string" && value.startsWith("http")) {
          const kind = inferKindFromUrl(value, port, node.type);
          await prisma.asset.create({
            data: {
              brandId: state.ctx.brandId ?? null,
              projectId: state.ctx.projectId ?? null,
              storagePath: "",
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
    }

    await prisma.runStep.update({
      where: { id: runStep.id },
      data: {
        status: "done",
        finishedAt: new Date(),
        costUsd: cost,
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
      // Retry loop for the graph persist. Serialised per workflow (withGraphLock)
      // and done as a plain read-then-update — NOT an interactive transaction —
      // so we never hold the workflow row lock open across a serverless
      // suspension. Up to 3 attempts with exponential backoff. Pure UPDATE so
      // retrying is safe — idempotent by node id.
      const MAX_ATTEMPTS = 3;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          await withGraphLock(state.ctx.workflowId!, async () => {
            const wf = await prisma.workflow.findUnique({
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
            // GENERATION HISTORY: before overwriting, push the node's previous
            // media results onto its history (newest first, deduped, capped) -
            // a re-run must never silently destroy the last result.
            const prevNode = nodesArr[idx] as {
              outputs?: Record<string, unknown>;
              results?: { value: string; mime?: string }[];
              history?: { value: string; mime?: string }[];
            };
            const HISTORY_CAP = 24;
            const prevUrls: { value: string; mime?: string }[] = [];
            if (prevNode.results?.length) {
              for (const r of prevNode.results) if (typeof r?.value === "string" && r.value.startsWith("http")) prevUrls.push({ value: r.value, mime: r.mime });
            } else if (prevNode.outputs) {
              for (const [k, v] of Object.entries(prevNode.outputs)) {
                if (k === "track_url" || k.startsWith("_")) continue;
                if (typeof v === "string" && v.startsWith("http")) prevUrls.push({ value: v });
              }
            }
            const newUrls = new Set<string>();
            if (result.results) for (const r of result.results) if (typeof r?.value === "string") newUrls.add(r.value);
            for (const v of Object.values(result.outputs)) if (typeof v === "string") newUrls.add(v);
            const seenHist = new Set<string>(newUrls);
            const history: { value: string; mime?: string }[] = [];
            for (const h of [...prevUrls, ...(prevNode.history ?? [])]) {
              if (!h || typeof h.value !== "string" || seenHist.has(h.value)) continue;
              seenHist.add(h.value);
              history.push(h);
              if (history.length >= HISTORY_CAP) break;
            }
            nodesArr[idx] = {
              ...nodesArr[idx],
              ...(history.length > 0 ? { history } : {}),
              outputs: result.outputs,
              // Staleness signature of the config+inputs that produced these
              // outputs — checked before reusing them on later subgraph runs.
              outputsSig: computeExecSig(node, inputs),
              // Persist `result.results` directly when the runner provides it
              // (multi-result nodes — imageGen with num_results>1, batched
              // video, etc). When there are 0/1 results, leave undefined so
              // the single-output path renders correctly.
              ...(result.results && result.results.length > 1
                ? { results: result.results }
                : { results: undefined }),
            };
            await prisma.workflow.update({
              where: { id: state.ctx.workflowId! },
              data: { graph: { ...g, nodes: nodesArr } as never },
            });
          });
          // Success — bail out of retry loop.
          break;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          const isTransient =
            msg.includes("connection pool") ||
            msg.includes("statement timeout") ||
            msg.includes("P2024") ||
            msg.includes("57014");
          if (isTransient && attempt < MAX_ATTEMPTS) {
            // Backoff: 250ms, 750ms before next attempt.
            const delayMs = 250 * Math.pow(3, attempt - 1);
            console.warn(
              `[executor] graph persist attempt ${attempt}/${MAX_ATTEMPTS} hit transient DB issue, retrying in ${delayMs}ms:`,
              msg.slice(0, 150),
            );
            await new Promise((res) => setTimeout(res, delayMs));
            continue;
          }
          // Non-transient OR final attempt failed — log and move on. The
          // RunStep is already saved with outputData; client polling will
          // still pick up the result. The carousel-after-refresh symptom
          // returns if persist fails AND user reloads before polling
          // syncs — rare but possible. We log loudly so we know.
          console.error(
            `[executor] graph persist FAILED after ${attempt} attempt(s):`,
            e,
          );
          break;
        }
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

function inferKindFromUrl(url: string, port: string, nodeType?: string): "image" | "video" | "audio" | "text" {
  // 1. By node category — the most reliable signal (a videoGen node always
  //    produces video, regardless of the URL shape).
  const cat = nodeType ? NODE_TYPES[nodeType]?.category : undefined;
  if (cat === "image" || cat === "video" || cat === "audio") return cat;
  // 2. By port hint
  if (port.toLowerCase().includes("image") || port === "character" || port === "composed") return "image";
  if (port.toLowerCase().includes("video") || port === "section") return "video";
  if (port.toLowerCase().includes("audio")) return "audio";
  // 3. By extension (strip query string first)
  const ext = url.split("?")[0].split(".").pop()?.toLowerCase() ?? "";
  if (["mp4", "webm", "mov", "m4v"].includes(ext)) return "video";
  if (["mp3", "wav", "m4a", "ogg", "aac", "flac"].includes(ext)) return "audio";
  if (["jpg", "jpeg", "png", "webp", "gif", "avif"].includes(ext)) return "image";
  // 4. An http(s) asset with no other hint is media, NOT text — text outputs
  //    are plain strings and never reach here. Default to image.
  if (url.startsWith("http")) return "image";
  return "text";
}

/** Sig-aware cache reuse pass for subgraph runs. A node's persisted outputs
 *  are reused ONLY when: it is not the scope node (always re-runs), every
 *  in-scope upstream was itself reused (dirty ancestors invalidate the whole
 *  branch), and the staleness signature still matches the node's current
 *  config + the inputs it would receive right now. Legacy graphs without a
 *  stored sig are grandfathered as clean. This kills the "stale prompt"
 *  class of bugs: edited prompts, rewired inputs and changed upstream
 *  selections all invalidate the cache. */
export function computeReusable(
  graph: Graph,
  scope: Set<string> | undefined | null,
  scopeNodeIds: string[] | undefined,
): { outputs: Map<string, Record<string, unknown>>; results: Map<string, { value: string; mime?: string }[]> } {
  const outputs = new Map<string, Record<string, unknown>>();
  const results = new Map<string, { value: string; mime?: string }[]>();
  const done = new Set<string>();
  const scopeIds = scope ?? new Set(graph.nodes.map((n) => n.id));
  const scopedOrder = topoSort(graph, scope ?? undefined);
  for (const nodeId of scopedOrder) {
    if (scopeNodeIds?.includes(nodeId)) continue; // requested nodes always re-run
    const node = graph.nodes.find((n) => n.id === nodeId);
    if (!node) continue;
    const snap = node as GraphNode & {
      outputs?: Record<string, unknown>;
      results?: { value: string; mime?: string }[];
      outputsSig?: string;
    };
    const cached = snap.outputs;
    if (!cached || Object.keys(cached).length === 0) continue;
    const upstreamClean = graph.edges.every(
      (e) => e.to.nodeId !== nodeId || !scopeIds.has(e.from.nodeId) || done.has(e.from.nodeId),
    );
    if (!upstreamClean) {
      console.log(`[executor] cache invalidated for ${nodeId} (dirty upstream)`);
      continue;
    }
    if (snap.outputsSig !== undefined) {
      const wouldReceive = resolveInputs(graph, node, outputs, results);
      if (snap.outputsSig !== computeExecSig(node, wouldReceive)) {
        console.log(`[executor] cache invalidated for ${nodeId} (config/inputs changed)`);
        continue;
      }
    }
    outputs.set(nodeId, cached);
    done.add(nodeId);
    // Restore the multi-result array too - multi-result nodes must pass ALL
    // their URLs downstream, not just the first.
    if (snap.results && snap.results.length > 0) results.set(nodeId, snap.results);
  }
  return { outputs, results };
}

// ─── Granular execution API (patch 343) ─────────────────────────────────────
// Used by the Inngest worker to run ONE node per step.run: completed steps are
// memoised by Inngest, so a retry re-executes ONLY the failed node instead of
// the whole workflow. Everything dynamic flows through step results (plain
// JSON), which keeps retries deterministic.

export type NodeStepResult = {
  outputs: Record<string, unknown>;
  results?: { value: string; mime?: string }[];
  costUsd: number;
  durationMs: number;
};

/** Build the execution plan for a run: depth layers of node ids that must
 *  actually execute, plus the reusable cached outputs (plain objects - the
 *  result is serialised into an Inngest step). */
export function planRun(
  graph: Graph,
  scopeNodeIds?: string[],
): {
  layers: string[][];
  cachedOutputs: Record<string, Record<string, unknown>>;
  cachedResults: Record<string, { value: string; mime?: string }[]>;
} {
  const hasScope = (scopeNodeIds?.length ?? 0) > 0;
  // Union of every requested node's ancestor set.
  const scope = hasScope
    ? new Set(scopeNodeIds!.flatMap((id) => [...ancestorsOf(graph, id)]))
    : undefined;
  const reusable = hasScope
    ? computeReusable(graph, scope, scopeNodeIds)
    : { outputs: new Map<string, Record<string, unknown>>(), results: new Map<string, { value: string; mime?: string }[]>() };
  const order = topoSort(graph, scope);
  const layers = layerByDepth(graph, order)
    .map((layer) => (layer ?? []).filter((id) => !reusable.outputs.has(id)))
    .filter((layer) => layer.length > 0);
  return {
    layers,
    cachedOutputs: Object.fromEntries(reusable.outputs),
    cachedResults: Object.fromEntries(reusable.results),
  };
}

/** Execute exactly one node with the accumulated upstream outputs. Throws on
 *  node failure (after recording the run step error) so the Inngest step can
 *  retry it. */
export async function runSingleNode(
  graph: Graph,
  nodeId: string,
  prior: {
    outputs: Record<string, Record<string, unknown>>;
    results: Record<string, { value: string; mime?: string }[]>;
  },
  ctx: RunnerContext,
  runId: string,
  opts?: {
    /** Requested (target) nodes always execute. Ancestors get a just-in-time
     *  reuse check against the freshest persisted graph - closes the race
     *  where PARALLEL manual runs share a dirty ancestor: whichever run
     *  executes it first persists the output, the other reuses it. */
    alwaysRun?: boolean;
  },
): Promise<NodeStepResult> {
  const node = graph.nodes.find((n) => n.id === nodeId);
  if (!node) throw new Error(`Node ${nodeId} not found in graph`);
  if (!opts?.alwaysRun && ctx.workflowId) {
    try {
      const wf = await prisma.workflow.findUnique({ where: { id: ctx.workflowId }, select: { graph: true } });
      const dbNode = ((wf?.graph as { nodes?: GraphNode[] } | null)?.nodes ?? []).find((n) => n.id === nodeId);
      if (dbNode?.outputs && Object.keys(dbNode.outputs).length > 0 && dbNode.outputsSig) {
        const would = resolveInputs(
          graph,
          node,
          new Map(Object.entries(prior.outputs)),
          new Map(Object.entries(prior.results)),
        );
        if (dbNode.outputsSig === computeExecSig(node, would)) {
          console.log(`[executor] JIT reuse for ${nodeId} (persisted by a concurrent/earlier run)`);
          return {
            outputs: dbNode.outputs,
            results: dbNode.results,
            costUsd: 0,
            durationMs: 0,
          };
        }
      }
    } catch { /* non-fatal - fall through to normal execution */ }
  }
  const state: ExecState = {
    graph,
    outputs: new Map(Object.entries(prior.outputs)),
    status: new Map(),
    errors: new Map(),
    results: new Map(Object.entries(prior.results)),
    costByNode: new Map(),
    durationByNode: new Map(),
    runId,
    ctx,
    scope: null,
  };
  await executeOne(node, state);
  return {
    outputs: state.outputs.get(nodeId) ?? {},
    results: state.results.get(nodeId),
    costUsd: state.costByNode.get(nodeId) ?? 0,
    durationMs: state.durationByNode.get(nodeId) ?? 0,
  };
}

/** Execute a whole graph (or scope) — parallel within depth layers */
export async function executeGraph(
  graph: Graph,
  ctx: RunnerContext,
  opts: { scope?: Set<string>; runId: string; scopeNodeIds?: string[] },
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
  const isSubgraphRun = (opts.scopeNodeIds?.length ?? 0) > 0;
  if (isSubgraphRun) {
    const reusable = computeReusable(graph, opts.scope, opts.scopeNodeIds);
    for (const [id, out] of reusable.outputs) {
      state.outputs.set(id, out);
      state.status.set(id, "done");
    }
    for (const [id, res] of reusable.results) state.results.set(id, res);
    console.log(`[executor] subgraph run scope=${opts.scopeNodeIds?.join('+')}, ${reusable.outputs.size} nodes reused from cache`);
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
