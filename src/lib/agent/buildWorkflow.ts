// ─────────────────────────────────────────────────────────────────────────
// Workflow Builder (text → graph)
//
// Turns a natural-language brief into a valid FlowLab canvas Graph. The node
// catalog spec is generated from NODE_TYPES at call time, so the agent always
// targets the real, current set of nodes/ports (no drift). The model's output
// is never trusted directly: every node type, port and edge is validated, and
// nodes are auto-laid-out left→right by dependency depth.
//
// Reused as a tool by the chat agent (patch 89+).
// ─────────────────────────────────────────────────────────────────────────
import {
  NODE_TYPES,
  makeNode,
  makeEdge,
  portsCompatible,
  getActiveInputs,
  type Graph,
  type GraphNode,
  type PortKind,
} from "@/lib/canvas/types";
import { callAgent } from "@/lib/agent/router";

// Compact, machine-readable description of every available node, fed to the
// model so it can only build with real node types and real port names.
function nodeCatalogSpec(): string {
  const lines: string[] = [];
  for (const [type, def] of Object.entries(NODE_TYPES)) {
    const ins =
      def.inputs
        .map((p) => `${p.name}:${p.type}${p.multi ? "[]" : ""}${p.optional ? "?" : ""}`)
        .join(", ") || "—";
    const outs = def.outputs.map((p) => `${p.name}:${p.type}`).join(", ") || "—";
    const primary = def.primaryField ? ` primary=${def.primaryField}` : "";
    lines.push(`- ${type} [${def.category}]${primary} | in: ${ins} | out: ${outs} | ${def.description}`);
  }
  return lines.join("\n");
}

const RULES = `You are FlowLab's workflow architect. Given a creative brief, design a node graph for FlowLab's canvas.

Output STRICT JSON ONLY (no markdown, no prose outside JSON) of the shape:
{
  "summary": "one short sentence describing the workflow you built",
  "nodes": [
    { "ref": "unique-label", "type": "<one of the catalog types>", "prompt": "main instruction text for this node (optional)", "config": { } }
  ],
  "edges": [
    { "from": { "ref": "node-label", "port": "<output port name>" }, "to": { "ref": "node-label", "port": "<input port name>" } }
  ]
}

Rules:
- The user's brief may be written in Russian or any other language. ALWAYS write every node's "prompt"/instruction text in ENGLISH, and write the "summary" in English too — regardless of the brief's language. (Image/video models render on-screen text in English and respond best to English prompts.)
- Use ONLY node types from the catalog below. Never invent a type or a port name.
- "ref" is your own temporary label to wire edges; it must be unique within nodes.
- Put the node's main instruction (the prompt/script/description) in "prompt". It is written into the node's primary field automatically.
- Connect nodes only via ports that exist on each node, and only when port TYPES are compatible (image→image, video→video, text→text; "any" matches anything).
- Build the SMALLEST graph that satisfies the brief. Prefer a clear linear/branching pipeline. Typical shape: text/idea → image(s) → video → assemble/export.
- Always finish with an appropriate output/export node when the brief implies a deliverable.
- Keep it under ~12 nodes unless the brief clearly needs more.`;

type RawNode = { ref?: string; type?: string; prompt?: string; config?: Record<string, unknown> };
type RawEdge = { from?: { ref?: string; port?: string }; to?: { ref?: string; port?: string } };
type RawPlan = { summary?: string; nodes?: RawNode[]; edges?: RawEdge[] };

function parsePlan(text: string): RawPlan {
  const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  // Tolerate leading/trailing prose by grabbing the outermost JSON object.
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  const slice = start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned;
  return JSON.parse(slice) as RawPlan;
}

// Left→right layout by longest-path depth; nodes at the same depth stack down.
function layout(nodes: GraphNode[], edges: Graph["edges"]) {
  const depth = new Map<string, number>();
  nodes.forEach((n) => depth.set(n.id, 0));
  for (let i = 0; i < nodes.length; i++) {
    let changed = false;
    for (const e of edges) {
      const d = (depth.get(e.from.nodeId) ?? 0) + 1;
      if (d > (depth.get(e.to.nodeId) ?? 0)) {
        depth.set(e.to.nodeId, d);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const perDepth = new Map<number, number>();
  for (const n of nodes) {
    const d = depth.get(n.id) ?? 0;
    const row = perDepth.get(d) ?? 0;
    perDepth.set(d, row + 1);
    n.position = { x: 80 + d * 340, y: 80 + row * 190 };
  }
}

export type BuildResult = { graph: Graph; summary: string; warnings: string[] };

export async function buildWorkflowGraph(
  brief: string,
  opts?: { brandHint?: string },
): Promise<BuildResult> {
  const system = `${RULES}\n\nNODE CATALOG (type [category] primary=field | in: ports | out: ports | description):\n${nodeCatalogSpec()}`;
  const user = opts?.brandHint ? `${brief}\n\nBrand context: ${opts.brandHint}` : brief;

  const res = await callAgent({ task: "generate", provider: "openai", json: true, system, user });

  let plan: RawPlan;
  try {
    plan = parsePlan(res.text);
  } catch {
    throw new Error("The model did not return valid JSON. Try rephrasing the brief.");
  }

  const warnings: string[] = [];
  const refToNode = new Map<string, GraphNode>();
  const nodes: GraphNode[] = [];

  for (const raw of plan.nodes ?? []) {
    const type = raw.type ?? "";
    if (!NODE_TYPES[type]) {
      warnings.push(`Skipped node "${raw.ref ?? "?"}": unknown type "${type}".`);
      continue;
    }
    if (!raw.ref || refToNode.has(raw.ref)) {
      warnings.push(`Skipped node with missing/duplicate ref ("${raw.ref ?? "?"}").`);
      continue;
    }
    const node = makeNode(type, { x: 0, y: 0 });
    const def = NODE_TYPES[type];
    if (raw.prompt && def.primaryField) {
      node.config[def.primaryField] = raw.prompt;
    }
    if (raw.config && typeof raw.config === "object") {
      node.config = { ...node.config, ...raw.config };
    }
    refToNode.set(raw.ref, node);
    nodes.push(node);
  }

  if (nodes.length === 0) {
    throw new Error("The model produced no valid nodes. Try a more specific brief.");
  }

  const edges: Graph["edges"] = [];
  for (const raw of plan.edges ?? []) {
    const fromRef = raw.from?.ref ?? "";
    const toRef = raw.to?.ref ?? "";
    const src = refToNode.get(fromRef);
    const dst = refToNode.get(toRef);
    if (!src || !dst) {
      warnings.push(`Skipped edge ${fromRef}→${toRef}: unknown node ref.`);
      continue;
    }
    const fromPortName = raw.from?.port ?? "";
    const toPortName = raw.to?.port ?? "";
    const outPort = NODE_TYPES[src.type].outputs.find((p) => p.name === fromPortName);
    const inPort = getActiveInputs(NODE_TYPES[dst.type], dst.config).find((p) => p.name === toPortName);
    if (!outPort) {
      warnings.push(`Skipped edge ${fromRef}→${toRef}: no output "${fromPortName}" on ${src.type}.`);
      continue;
    }
    if (!inPort) {
      warnings.push(`Skipped edge ${fromRef}→${toRef}: no input "${toPortName}" on ${dst.type}.`);
      continue;
    }
    if (!portsCompatible(outPort.type as PortKind, inPort.type as PortKind)) {
      warnings.push(
        `Skipped edge ${fromRef}→${toRef}: incompatible types ${outPort.type}→${inPort.type}.`,
      );
      continue;
    }
    edges.push(makeEdge(src.id, fromPortName, dst.id, toPortName));
  }

  layout(nodes, edges);

  return {
    graph: { nodes, edges },
    summary: plan.summary?.trim() || `Built ${nodes.length} nodes.`,
    warnings,
  };
}
