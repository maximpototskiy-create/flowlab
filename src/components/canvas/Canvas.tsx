"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  NODE_TYPES, PORT_COLORS, makeNode, makeEdge, portsCompatible, addEdgeRespectingMulti,
  type Graph, type GraphNode, type PortKind, type Group, EMPTY_GRAPH,
} from "@/lib/canvas/types";
import { getVideoModel, defaultModelForMode, clampDuration, type VideoMode } from "@/lib/canvas/videoModels";
import CanvasNode, { NODE_WIDTH } from "./CanvasNode";
import CanvasEdges from "./CanvasEdges";
import Minimap from "./Minimap";
import GroupBox from "./GroupBox";
import NodePalette from "./NodePalette";
import ContextMenu from "./ContextMenu";
import ActionMenu, { type ActionItem } from "./ActionMenu";
import HelpHints from "./HelpHints";
import AssetDrawer from "./AssetDrawer";
import type { AssetItem } from "@/lib/assetsQuery";
import ConnectionPicker from "./ConnectionPicker";
import NodeExpandedModal from "./NodeExpandedModal";
import CanvasToolbar from "./CanvasToolbar";
import WorkflowBuilderPanel from "./WorkflowBuilderPanel";
import RunsPanel, { type RunSummary } from "./RunsPanel";
import { pokeActiveRuns } from "../ActiveRunsIndicator";
import { saveWorkflowGraph } from "@/lib/actions";
import { autoLayout } from "@/lib/canvas/autoLayout";
import { Minus, Plus, Maximize, Grid3X3, Network, Play, Copy, Trash2, Group as GroupIcon, Ungroup, Pencil, HelpCircle, Undo2, Redo2, Images } from "lucide-react";

type Drag = {
  nodeId: string;
  startX: number;
  startY: number;
  pointerX: number;
  pointerY: number;
  // When dragging a multi-selection, the start positions of every node
  // that moves together (includes the grabbed node). Absent = single node.
  group?: { nodeId: string; startX: number; startY: number }[];
};
type EdgeDraft = {
  fromNode: string;
  fromPort: string;
  fromKind: PortKind;
  x1: number; y1: number; x2: number; y2: number;
};

const STORAGE_AREA = { width: 5000, height: 4000 };

// Group accent colours. Keys are stored in Group.color; values drive the
// box border/background/label. Plain hex so they work in inline styles
// regardless of Tailwind's purge.
const GROUP_COLORS: Record<string, string> = {
  brand: "16 185 129", // emerald (default)
  blue: "59 130 246",
  violet: "139 92 246",
  amber: "245 158 11",
  rose: "244 63 94",
  slate: "100 116 139",
};
const GROUP_COLOR_KEYS = Object.keys(GROUP_COLORS);
function groupRGB(color?: string): string {
  return GROUP_COLORS[color ?? "brand"] ?? GROUP_COLORS.brand;
}

// Drop deleted nodes from groups and discard groups that fall below 2
// members. `remaining` is the surviving node list.
function cleanGroups(groups: Group[] | undefined, remaining: GraphNode[]): Group[] {
  const live = new Set(remaining.map((n) => n.id));
  return (groups ?? [])
    .map((gr) => ({ ...gr, nodeIds: gr.nodeIds.filter((id) => live.has(id)) }))
    .filter((gr) => gr.nodeIds.length >= 2);
}

export default function Canvas({
  workflowId,
  workflowName,
  workflowMeta,
  initialGraph,
  initialActiveRun,
}: {
  workflowId: string;
  workflowName: string;
  workflowMeta: { brandId: string | null; brandSlug: string | null; projectId: string };
  initialGraph: Graph;
  initialActiveRun?: {
    runId: string;
    startedAt: string;
    steps: {
      nodeId: string;
      status: "pending" | "running" | "done" | "error";
      outputData: Record<string, unknown> | null;
      errorMessage: string | null;
    }[];
  } | null;
}) {
  // ─────────────────────────────── Graph state
  const [graph, setGraph] = useState<Graph>(() => {
    // If we landed on this workflow with a run already in flight, pre-apply
    // those step statuses onto the corresponding nodes immediately — so the
    // user sees live spinners instead of idle nodes for the half-second
    // before polling kicks in.
    const base = initialGraph?.nodes ? initialGraph : EMPTY_GRAPH;
    if (!initialActiveRun?.steps?.length) return base;
    const stepByNode = new Map(initialActiveRun.steps.map((s) => [s.nodeId, s]));
    return {
      ...base,
      nodes: base.nodes.map((n) => {
        const step = stepByNode.get(n.id);
        if (!step) return n;
        return {
          ...n,
          status: step.status,
          // Don't overwrite outputs/results if the saved graph already has
          // them (the executor's server-side persist might have run); but if
          // the step has fresh outputData and the node has none, populate.
          outputs:
            n.outputs && Object.keys(n.outputs).length > 0
              ? n.outputs
              : (step.outputData as typeof n.outputs) ?? n.outputs,
          error: step.errorMessage ?? n.error,
        };
      }),
    };
  });
  // Multi-select: a Set of selected node ids. Single-select is just a
  // one-element set. `selected` (legacy single id) is derived as the sole
  // member when exactly one node is selected — used by actions that only
  // make sense for one node (copy/duplicate/run/expand).
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const selected = selectedIds.size === 1 ? [...selectedIds][0] : null;
  // Ref mirror so group ops can read the current selection without nesting
  // setGraph inside a setSelectedIds updater (that double-fires in strict
  // mode → duplicate side effects, which caused flaky right-click grouping).
  const selectedIdsRef = useRef(selectedIds);
  useEffect(() => { selectedIdsRef.current = selectedIds; }, [selectedIds]);
  function setSelected(id: string | null) {
    setSelectedIds(id ? new Set([id]) : new Set());
  }
  // Marquee (rubber-band) selection rectangle, in canvas coords. Null when
  // not marqueeing.
  const [marquee, setMarquee] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);

  // ─────────────────────────────── Save state
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const skipNextSave = useRef(true); // skip first save (we just loaded the graph)

  // ─────────────────────────────── Pan/Zoom
  const [pan, setPan] = useState({ x: 200, y: 100 });
  const [zoom, setZoom] = useState(1);
  // Viewport pixel size — tracked for the minimap's viewport rectangle.
  const [viewportSize, setViewportSize] = useState({ w: 0, h: 0 });
  // Spacebar-hold pan: standard Figma/Miro pattern. Hold Space and drag
  // with left button to pan the canvas, even on top of nodes. Released —
  // back to normal interaction.
  const [spaceHeld, setSpaceHeld] = useState(false);
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      // Ignore when typing in inputs/textareas — Space there inserts a space.
      const t = e.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable) return;
      if (e.code === "Space" && !spaceHeld) {
        e.preventDefault();
        setSpaceHeld(true);
      }
    }
    function onKeyUp(e: KeyboardEvent) {
      if (e.code === "Space") setSpaceHeld(false);
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [spaceHeld]);
  const canvasRef = useRef<HTMLDivElement>(null);
  const [isPanning, setIsPanning] = useState(false);
  const panStart = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);

  // Track viewport pixel size for the minimap. ResizeObserver keeps it in
  // sync with window/panel resizes without polling.
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const update = () => {
      const r = el.getBoundingClientRect();
      setViewportSize({ w: r.width, h: r.height });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ─────────────────────────────── Drag
  const [drag, setDrag] = useState<Drag | null>(null);
  // Live drag position — updated every animation frame for INSTANT visual response.
  // We mutate the DOM transform directly instead of going through React state on each frame.
  // Only commit to setGraph on pointer up.
  const liveDragPos = useRef<{ x: number; y: number } | null>(null);
  // Live positions of ALL nodes moving in the current (possibly multi-node)
  // drag — keyed by nodeId. Read by CanvasEdges so every dragged node's
  // edges follow in real time.
  const liveDragPositions = useRef<Map<string, { x: number; y: number }> | null>(null);
  // Marquee rubber-band rectangle in canvas coords (mirrors `marquee` state
  // for the always-mounted pointer listeners).
  const marqueeRef = useRef<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  // Real measured node heights (px), keyed by id — used for non-overlapping
  // auto-organize and for accurate group-box bounds. offsetHeight is the
  // node's CSS layout height (transform scale doesn't affect it), i.e. in
  // canvas coordinates. Refreshed after graph changes and during drags.
  const [nodeHeights, setNodeHeights] = useState<Map<string, number>>(new Map());
  function measureNodeHeights(): Map<string, number> {
    const m = new Map<string, number>();
    for (const n of graphRef.current.nodes) {
      const el = document.querySelector(`[data-node-id="${n.id}"]`) as HTMLElement | null;
      if (el) m.set(n.id, el.offsetHeight);
    }
    return m;
  }
  // Tick increments on every drag frame to make edges re-render with the new position.
  // (Nodes themselves use direct DOM transform — no React re-render needed.)
  const [dragTick, setDragTick] = useState(0);

  // ─────────────────────────────── Edge draft
  const [edgeDraft, setEdgeDraft] = useState<EdgeDraft | null>(null);

  // ─────────────────────────────── Context menu & pickers
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; canvasX: number; canvasY: number } | null>(null);
  // Action context menu (right-click on a node or group) — distinct from the
  // node-picker `ctxMenu`.
  const [actionMenu, setActionMenu] = useState<{ x: number; y: number; kind: "node" | "group"; id: string } | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [showAssets, setShowAssets] = useState(false);

  // Create an upload node pre-filled with a library asset's URL, at canvas
  // coords. kind → node type. The upload runners read config.cdnUrl.
  const addAssetNode = useCallback((cdnUrl: string, kind: string, canvasX: number, canvasY: number) => {
    const type = kind === "video" ? "uploadVideo" : kind === "audio" ? "uploadAudio" : "uploadImage";
    const newNode = makeNode(type, { x: canvasX - NODE_WIDTH / 2, y: canvasY - 30 });
    newNode.config = { ...newNode.config, cdnUrl };
    setGraph((g) => ({ ...g, nodes: [...g.nodes, newNode] }));
    setSelected(newNode.id);
  }, []);
  const [connPicker, setConnPicker] = useState<{
    screenX: number; screenY: number; canvasX: number; canvasY: number;
    fromNode: string; fromPort: string; fromKind: PortKind;
  } | null>(null);

  // ─────────────────────────────── Hovered edge
  const [hoveredEdge, setHoveredEdge] = useState<string | null>(null);

  // ─────────────────────────────── Expanded modal
  const [expandedNodeId, setExpandedNodeId] = useState<string | null>(null);

  // Reverse bridge: the editor stashes its rendered MP4 URL per workflow;
  // pick it up here and make it the Editor node's output (usable downstream).
  useEffect(() => {
    const KEY = `flowlab.editor.export.v1:${workflowId}`;
    const apply = () => {
      try {
        const raw = localStorage.getItem(KEY);
        if (!raw) return;
        const j = JSON.parse(raw) as { url?: string };
        if (!j.url) { localStorage.removeItem(KEY); return; }
        localStorage.removeItem(KEY);
        setGraph((g) => ({
          ...g,
          nodes: g.nodes.map((n) => n.type === "composer"
            ? { ...n, config: { ...n.config, exportUrl: j.url }, outputs: { ...(n.outputs ?? {}), video: j.url as string }, status: "done" as const }
            : n),
        }));
      } catch { /* */ }
    };
    apply();
    const onStorage = (e: StorageEvent) => { if (e.key === KEY) apply(); };
    const onFocus = () => apply();
    window.addEventListener("storage", onStorage);
    window.addEventListener("focus", onFocus);
    return () => { window.removeEventListener("storage", onStorage); window.removeEventListener("focus", onFocus); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workflowId]);

  // ─────────────────────────────── Runs
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const activeRunPoll = useRef<Map<string, ReturnType<typeof setInterval>>>(new Map());

  // CRITICAL: Stop ALL polling intervals when the component unmounts (workflow
  // switch, browser tab close, navigation). Without this, intervals leak and
  // keep hammering /api/runs/[id] forever, exhausting the DB connection pool.
  useEffect(() => {
    const polls = activeRunPoll.current;
    return () => {
      for (const interval of polls.values()) {
        clearInterval(interval);
      }
      polls.clear();
    };
  }, []);

  // If the user returns to a workflow that already has a generation in flight,
  // resume polling immediately so the live status keeps updating. The status
  // overlay on the affected nodes is already painted in via initialActiveRun
  // (see graph useState above), but without polling those spinners would
  // never advance to "done".
  useEffect(() => {
    if (!initialActiveRun?.runId) return;
    // Seed the RunsPanel with a placeholder summary so the user sees the run
    // in the side panel too.
    setRuns((rs) => {
      if (rs.some((r) => r.id === initialActiveRun.runId)) return rs;
      return [
        {
          id: initialActiveRun.runId,
          name: "Resumed run",
          status: "running" as const,
          startedAt: new Date(initialActiveRun.startedAt).getTime(),
          totalCostUsd: 0,
          steps: initialActiveRun.steps.map((s) => ({
            nodeId: s.nodeId,
            nodeName: s.nodeId,
            status: s.status,
            costUsd: 0,
          })),
        },
        ...rs,
      ];
    });
    setIsRunning(true);
    // Kick off polling immediately. pollRun is defined below in this component;
    // calling it from inside this effect is safe because function declarations
    // are hoisted.
    pollRun(initialActiveRun.runId, "resumed");
    // We intentionally run this only once on mount — if the run finishes,
    // pollRun's own clearInterval will stop it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─────────────────────────────── Convert screen->canvas coords
  const screenToCanvas = useCallback(
    (clientX: number, clientY: number) => {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return { x: 0, y: 0 };
      return {
        x: (clientX - rect.left - pan.x) / zoom,
        y: (clientY - rect.top - pan.y) / zoom,
      };
    },
    [pan, zoom],
  );

  // ─────────────────────────────── Autosave on graph change
  useEffect(() => {
    if (skipNextSave.current) {
      skipNextSave.current = false;
      return;
    }
    if (saveTimer.current) clearTimeout(saveTimer.current);
    setSaveState("saving");
    saveTimer.current = setTimeout(async () => {
      try {
        // Keep generated outputs/results in the saved snapshot so they survive
        // a page refresh. Without this, every reload wipes all generated
        // images, videos and text from the canvas (the files themselves still
        // live in Supabase Storage, but the node→URL mapping is lost).
        // Status/error are intentionally NOT persisted — they're volatile
        // runtime state.
        const cleaned: Graph = {
          nodes: graph.nodes.map((n) => ({
            id: n.id,
            type: n.type,
            position: n.position,
            config: n.config,
            outputs: n.outputs,
            results: n.results,
          })),
          edges: graph.edges,
          // Persist groups too — without this they vanish on every reload.
          groups: graph.groups,
        };
        await saveWorkflowGraph(workflowId, cleaned);
        setSaveState("saved");
        setTimeout(() => setSaveState("idle"), 1200);
      } catch {
        setSaveState("error");
      }
    }, 200);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [graph.nodes, graph.edges, workflowId]);

  // ─────────────────────────────── Mutators
  const addNodeAt = useCallback(
    (type: string, canvasX: number, canvasY: number, opts?: { connectFrom?: { node: string; port: string }; toInput?: string }) => {
      const newNode = makeNode(type, { x: canvasX - NODE_WIDTH / 2, y: canvasY - 30 });
      setGraph((g) => {
        const next: Graph = { nodes: [...g.nodes, newNode], edges: g.edges, groups: g.groups };
        if (opts?.connectFrom && opts.toInput) {
          next.edges = [...next.edges, makeEdge(opts.connectFrom.node, opts.connectFrom.port, newNode.id, opts.toInput)];
        }
        return next;
      });
      setSelected(newNode.id);
    },
    [],
  );

  // ── AI Workflow Builder ──
  const [builderOpen, setBuilderOpen] = useState(false);
  const applyBuiltGraph = useCallback((built: Graph, mode: "insert" | "replace") => {
    setGraph((g) => {
      if (mode === "replace") {
        return { nodes: built.nodes, edges: built.edges, groups: [] };
      }
      // Insert: drop the generated graph to the right of existing nodes so it
      // doesn't overlap. Generated ids are random (n_…) so they won't collide.
      const maxX = g.nodes.reduce((m, n) => Math.max(m, n.position.x), 0);
      const dx = g.nodes.length ? maxX + 400 : 0;
      const shifted = built.nodes.map((n) => ({ ...n, position: { x: n.position.x + dx, y: n.position.y } }));
      return {
        nodes: [...g.nodes, ...shifted],
        edges: [...g.edges, ...built.edges],
        groups: g.groups,
      };
    });
    setBuilderOpen(false);
  }, []);

  const deleteNode = useCallback((nodeId: string) => {
    setGraph((g) => {
      const nodes = g.nodes.filter((n) => n.id !== nodeId);
      return {
        nodes,
        edges: g.edges.filter((e) => e.from.nodeId !== nodeId && e.to.nodeId !== nodeId),
        groups: cleanGroups(g.groups, nodes),
      };
    });
    setSelectedIds((s) => {
      if (!s.has(nodeId)) return s;
      const next = new Set(s);
      next.delete(nodeId);
      return next;
    });
    if (expandedNodeId === nodeId) setExpandedNodeId(null);
  }, [expandedNodeId]);

  // Delete every selected node (and their edges) in one shot.
  const deleteSelected = useCallback(() => {
    const sel = selectedIdsRef.current;
    if (sel.size === 0) return;
    setGraph((g) => {
      const nodes = g.nodes.filter((n) => !sel.has(n.id));
      return {
        nodes,
        edges: g.edges.filter((e) => !sel.has(e.from.nodeId) && !sel.has(e.to.nodeId)),
        groups: cleanGroups(g.groups, nodes),
      };
    });
    setSelectedIds(new Set());
  }, []);

  const deleteEdge = useCallback((edgeId: string) => {
    setGraph((g) => ({ ...g, edges: g.edges.filter((e) => e.id !== edgeId) }));
  }, []);

  // Select a node. additive (shift/cmd-click) toggles it in the current
  // selection; otherwise it becomes the sole selection.
  function toggleSelect(nodeId: string, additive?: boolean) {
    setSelectedIds((prev) => {
      if (additive) {
        const next = new Set(prev);
        if (next.has(nodeId)) next.delete(nodeId);
        else next.add(nodeId);
        return next;
      }
      if (prev.has(nodeId) && prev.size > 1) return prev;
      return new Set([nodeId]);
    });
  }

  // ─────────────────────────────── Groups
  // Group the current selection into a labelled box. Groups store only node
  // ids — their on-screen box is computed live from member positions, so it
  // follows drags and auto-organize automatically.
  const groupSelected = useCallback(() => {
    const sel = selectedIdsRef.current;
    if (sel.size < 2) return; // need ≥2 to form a group
    const ids = [...sel];
    const group: Group = { id: `grp-${Date.now().toString(36)}`, nodeIds: ids };
    setGraph((g) => ({ ...g, groups: [...(g.groups ?? []), group] }));
  }, []);

  // Ungroup: drop any group that contains a currently-selected node.
  const ungroupSelected = useCallback(() => {
    const sel = selectedIdsRef.current;
    if (sel.size === 0) return;
    setGraph((g) => ({
      ...g,
      groups: (g.groups ?? []).filter((gr) => !gr.nodeIds.some((id) => sel.has(id))),
    }));
  }, []);

  // Select every node belonging to a group (used when its box is clicked).
  function selectGroup(groupId: string, additive?: boolean) {
    const gr = (graph.groups ?? []).find((x) => x.id === groupId);
    if (!gr) return;
    setSelectedIds((prev) => {
      const next = additive ? new Set(prev) : new Set<string>();
      for (const id of gr.nodeIds) next.add(id);
      return next;
    });
  }

  // ── Per-group operations (used by the group box header controls) ──
  const renameGroup = useCallback((groupId: string, label: string) => {
    setGraph((g) => ({
      ...g,
      groups: (g.groups ?? []).map((gr) => (gr.id === groupId ? { ...gr, label } : gr)),
    }));
  }, []);

  const setGroupColor = useCallback((groupId: string, color: string) => {
    setGraph((g) => ({
      ...g,
      groups: (g.groups ?? []).map((gr) => (gr.id === groupId ? { ...gr, color } : gr)),
    }));
  }, []);

  // Ungroup a specific group (remove the box; nodes stay).
  const ungroupGroup = useCallback((groupId: string) => {
    setGraph((g) => ({ ...g, groups: (g.groups ?? []).filter((gr) => gr.id !== groupId) }));
  }, []);

  // Duplicate a whole group: clone its nodes (new ids, offset), re-wire the
  // internal edges between the clones, and create a new group around them.
  const duplicateGroup = useCallback((groupId: string) => {
    const OFFSET = 48;
    setGraph((g) => {
      const gr = (g.groups ?? []).find((x) => x.id === groupId);
      if (!gr) return g;
      const idMap = new Map<string, string>();
      const newNodes: GraphNode[] = [];
      for (const nid of gr.nodeIds) {
        const src = g.nodes.find((n) => n.id === nid);
        if (!src) continue;
        const nn = makeNode(src.type, { x: src.position.x + OFFSET, y: src.position.y + OFFSET });
        nn.config = JSON.parse(JSON.stringify(src.config));
        idMap.set(src.id, nn.id);
        newNodes.push(nn);
      }
      if (newNodes.length === 0) return g;
      const newEdges = g.edges
        .filter((e) => idMap.has(e.from.nodeId) && idMap.has(e.to.nodeId))
        .map((e) => makeEdge(idMap.get(e.from.nodeId)!, e.from.port, idMap.get(e.to.nodeId)!, e.to.port));
      const newGroup: Group = {
        id: `grp-${Date.now().toString(36)}`,
        nodeIds: newNodes.map((n) => n.id),
        label: gr.label ? `${gr.label} copy` : "Group copy",
        color: gr.color,
      };
      // Select the new clones.
      requestAnimationFrame(() => setSelectedIds(new Set(newNodes.map((n) => n.id))));
      return {
        ...g,
        nodes: [...g.nodes, ...newNodes],
        edges: [...g.edges, ...newEdges],
        groups: [...(g.groups ?? []), newGroup],
      };
    });
  }, []);

  // Duplicate the current multi-selection (nodes + the edges among them),
  // without forming a group.
  const duplicateSelection = useCallback(() => {
    const sel = selectedIdsRef.current;
    if (sel.size === 0) return;
    const OFFSET = 40;
    setGraph((g) => {
      const idMap = new Map<string, string>();
      const newNodes: GraphNode[] = [];
      for (const nid of sel) {
        const src = g.nodes.find((n) => n.id === nid);
        if (!src) continue;
        const nn = makeNode(src.type, { x: src.position.x + OFFSET, y: src.position.y + OFFSET });
        nn.config = JSON.parse(JSON.stringify(src.config));
        idMap.set(src.id, nn.id);
        newNodes.push(nn);
      }
      if (newNodes.length === 0) return g;
      const newEdges = g.edges
        .filter((e) => idMap.has(e.from.nodeId) && idMap.has(e.to.nodeId))
        .map((e) => makeEdge(idMap.get(e.from.nodeId)!, e.from.port, idMap.get(e.to.nodeId)!, e.to.port));
      requestAnimationFrame(() => setSelectedIds(new Set(newNodes.map((n) => n.id))));
      return { ...g, nodes: [...g.nodes, ...newNodes], edges: [...g.edges, ...newEdges] };
    });
  }, []);

  // Delete a group AND its member nodes (and their edges).
  const deleteGroup = useCallback((groupId: string) => {
    setGraph((g) => {
      const gr = (g.groups ?? []).find((x) => x.id === groupId);
      if (!gr) return g;
      const ids = new Set(gr.nodeIds);
      const nodes = g.nodes.filter((n) => !ids.has(n.id));
      return {
        nodes,
        edges: g.edges.filter((e) => !ids.has(e.from.nodeId) && !ids.has(e.to.nodeId)),
        groups: (g.groups ?? []).filter((x) => x.id !== groupId),
      };
    });
    setSelectedIds(new Set());
  }, []);

  // Auto-organize only the nodes inside one group, in place (anchored at the
  // group's current top-left so it doesn't jump across the canvas).
  const organizeGroup = useCallback((groupId: string) => {
    const heights = measureNodeHeights();
    setGraph((g) => {
      const gr = (g.groups ?? []).find((x) => x.id === groupId);
      if (!gr) return g;
      const ids = new Set(gr.nodeIds);
      const members = g.nodes.filter((n) => ids.has(n.id));
      if (members.length === 0) return g;
      const originX = Math.min(...members.map((n) => n.position.x));
      const originY = Math.min(...members.map((n) => n.position.y));
      const memberEdges = g.edges.filter((e) => ids.has(e.from.nodeId) && ids.has(e.to.nodeId));
      const pos = autoLayout(members, memberEdges, { heights, originX, originY });
      return {
        ...g,
        nodes: g.nodes.map((n) => {
          const p = pos.get(n.id);
          return p ? { ...n, position: p } : n;
        }),
      };
    });
  }, []);

  // Start dragging an entire group by its box — moves all member nodes.
  function startGroupDrag(groupId: string, e: React.PointerEvent) {
    const gr = (graph.groups ?? []).find((x) => x.id === groupId);
    if (!gr) return;
    const group = gr.nodeIds
      .map((id) => {
        const n = graph.nodes.find((x) => x.id === id);
        return n ? { nodeId: id, startX: n.position.x, startY: n.position.y } : null;
      })
      .filter((x): x is { nodeId: string; startX: number; startY: number } => x !== null);
    if (group.length === 0) return;
    selectGroup(groupId, e.shiftKey || e.metaKey || e.ctrlKey);
    setDrag({
      nodeId: group[0].nodeId,
      startX: group[0].startX,
      startY: group[0].startY,
      pointerX: e.clientX,
      pointerY: e.clientY,
      group,
    });
  }

  // Auto-organize: re-position nodes into a left-to-right layered layout
  // following the data-flow edges. Groups are treated as RIGID BLOCKS — a
  // group's internal layout is preserved (its nodes keep their relative
  // positions) and the whole block is placed as one unit, so organizing the
  // whole project no longer scrambles a group you've arranged by hand.
  const organizeNodes = useCallback(() => {
    const heights = measureNodeHeights();
    const PAD = 24;
    const LABEL_H = 26;
    setGraph((g) => {
      if (g.nodes.length === 0) return g;
      const groups = g.groups ?? [];

      // node id → group id
      const nodeToGroup = new Map<string, string>();
      for (const gr of groups) for (const id of gr.nodeIds) nodeToGroup.set(id, gr.id);

      // Build units: one per (non-empty) group + one per ungrouped node.
      type Unit = { id: string; nodeIds: string[]; w: number; h: number };
      const units: Unit[] = [];
      for (const gr of groups) {
        const members = gr.nodeIds
          .map((id) => g.nodes.find((n) => n.id === id))
          .filter((n): n is GraphNode => !!n);
        if (members.length === 0) continue;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const n of members) {
          const h = heights.get(n.id) ?? 120;
          minX = Math.min(minX, n.position.x);
          minY = Math.min(minY, n.position.y);
          maxX = Math.max(maxX, n.position.x + NODE_WIDTH);
          maxY = Math.max(maxY, n.position.y + h);
        }
        units.push({
          id: `grp:${gr.id}`,
          nodeIds: members.map((n) => n.id),
          w: maxX - minX + PAD * 2,
          h: maxY - minY + PAD * 2 + LABEL_H,
        });
      }
      for (const n of g.nodes) {
        if (!nodeToGroup.has(n.id)) {
          units.push({ id: n.id, nodeIds: [n.id], w: NODE_WIDTH, h: heights.get(n.id) ?? 120 });
        }
      }
      if (units.length === 0) return g;

      // node id → unit id, for projecting edges to the unit graph.
      const unitOf = new Map<string, string>();
      for (const u of units) for (const nid of u.nodeIds) unitOf.set(nid, u.id);

      // Pseudo-nodes + de-duplicated inter-unit edges for the layout pass.
      const unitNodes = units.map((u) => ({ id: u.id } as unknown as GraphNode));
      const seen = new Set<string>();
      const unitEdges = [] as { id: string; from: { nodeId: string; port: string }; to: { nodeId: string; port: string } }[];
      for (const e of g.edges) {
        const uf = unitOf.get(e.from.nodeId);
        const ut = unitOf.get(e.to.nodeId);
        if (uf && ut && uf !== ut) {
          const k = `${uf}->${ut}`;
          if (!seen.has(k)) {
            seen.add(k);
            unitEdges.push({ id: k, from: { nodeId: uf, port: "" }, to: { nodeId: ut, port: "" } });
          }
        }
      }

      const uWidths = new Map(units.map((u) => [u.id, u.w]));
      const uHeights = new Map(units.map((u) => [u.id, u.h]));
      const unitPos = autoLayout(unitNodes, unitEdges, { widths: uWidths, heights: uHeights });

      // Expand units back to node positions.
      const newPos = new Map<string, { x: number; y: number }>();
      for (const u of units) {
        const up = unitPos.get(u.id);
        if (!up) continue;
        if (u.nodeIds.length === 1 && !nodeToGroup.has(u.nodeIds[0])) {
          newPos.set(u.nodeIds[0], up);
        } else {
          // Group block: shift members preserving their relative layout.
          const members = u.nodeIds
            .map((id) => g.nodes.find((n) => n.id === id))
            .filter((n): n is GraphNode => !!n);
          const minX = Math.min(...members.map((n) => n.position.x));
          const minY = Math.min(...members.map((n) => n.position.y));
          const dx = up.x + PAD - minX;
          const dy = up.y + PAD + LABEL_H - minY;
          for (const n of members) {
            newPos.set(n.id, { x: n.position.x + dx, y: n.position.y + dy });
          }
        }
      }

      return {
        ...g,
        nodes: g.nodes.map((n) => {
          const p = newPos.get(n.id);
          return p ? { ...n, position: p } : n;
        }),
      };
    });
    setZoom(1);
    setPan({ x: 80, y: 80 });
  }, []);

  const updateNodeConfig = useCallback((nodeId: string, key: string, value: unknown) => {
    setGraph((g) => ({
      ...g,
      nodes: g.nodes.map((n) => {
        if (n.id !== nodeId) return n;
        const next = { ...n, config: { ...n.config, [key]: value } };
        // For Brand Assets node, changing the selection MUST invalidate
        // cached outputs/results — otherwise the executor's subgraph cache
        // serves stale URLs on re-run and the user's new selection has no
        // effect. Same logic applies to any future config-driven node
        // where the config materially changes what the runner produces.
        if (n.type === "brandAssets" && key === "selected") {
          next.outputs = undefined;
          next.results = undefined;
          next.status = "idle";
        }
        // Video Generation: keep Mode → Model → Duration consistent. Changing
        // the mode may make the current model invalid (e.g. a text-to-video
        // model while switching to Image mode), and switching models may make
        // the current duration unsupported (Veo only does 4/6/8). Fix both in
        // the same atomic update so the UI never shows an impossible combo.
        if (n.type === "videoGen") {
          if (key === "mode") {
            const m = getVideoModel(String(next.config.model ?? ""));
            if (!m || !m.modes.includes(value as VideoMode)) {
              const newModel = defaultModelForMode(value as VideoMode);
              next.config.model = newModel;
              next.config.duration = String(clampDuration(newModel, Number(next.config.duration ?? 5)));
            }
          } else if (key === "model") {
            next.config.duration = String(clampDuration(String(value), Number(next.config.duration ?? 5)));
            const nm = getVideoModel(String(value));
            const cur = String(next.config.resolution ?? "");
            if (!nm?.resolutions || !nm.resolutions.includes(cur)) next.config.resolution = nm?.resolutions?.[0] ?? "";
          }
        }
        return next;
      }),
    }));
  }, []);

  const updateNodeRuntime = useCallback((nodeId: string, patch: Partial<GraphNode>) => {
    setGraph((g) => ({
      ...g,
      nodes: g.nodes.map((n) => (n.id === nodeId ? { ...n, ...patch } : n)),
    }));
  }, []);

  // ─────────────────────────────── Drag handling
  function startNodeDrag(nodeId: string, e: React.PointerEvent) {
    e.stopPropagation();
    const node = graph.nodes.find((n) => n.id === nodeId);
    if (!node) return;
    // If the grabbed node is part of a multi-selection, drag the whole
    // selection together. Otherwise just this node.
    const groupIds =
      selectedIds.has(nodeId) && selectedIds.size > 1 ? [...selectedIds] : [nodeId];
    const group = groupIds
      .map((id) => {
        const n = graph.nodes.find((x) => x.id === id);
        return n ? { nodeId: id, startX: n.position.x, startY: n.position.y } : null;
      })
      .filter((x): x is { nodeId: string; startX: number; startY: number } => x !== null);
    setDrag({
      nodeId,
      startX: node.position.x,
      startY: node.position.y,
      pointerX: e.clientX,
      pointerY: e.clientY,
      group,
    });
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  }

  // ─────────────────────────────── Edge creation
  function startEdge(nodeId: string, portName: string, e: React.PointerEvent) {
    e.stopPropagation();
    const node = graph.nodes.find((n) => n.id === nodeId);
    const def = NODE_TYPES[node?.type ?? ""];
    if (!node || !def) return;
    const portIdx = def.outputs.findIndex((p) => p.name === portName);
    const port = def.outputs[portIdx];
    if (!port) return;
    const canvasPt = screenToCanvas(e.clientX, e.clientY);
    // Match CanvasEdges port calculation: NODE_HEADER_HEIGHT(36) + 14 + PORT_RADIUS(7) + idx*spacing(26)
    const portYpx = 36 + 14 + 7 + portIdx * 26;
    setEdgeDraft({
      fromNode: nodeId,
      fromPort: portName,
      fromKind: port.type,
      x1: node.position.x + NODE_WIDTH,
      y1: node.position.y + portYpx,
      x2: canvasPt.x,
      y2: canvasPt.y,
    });
  }

  function endEdgeOnInput(nodeId: string, portName: string, e: React.PointerEvent) {
    e.stopPropagation();
    if (!edgeDraft) return;
    const targetNode = graph.nodes.find((n) => n.id === nodeId);
    const def = NODE_TYPES[targetNode?.type ?? ""];
    const port = def?.inputs.find((p) => p.name === portName);
    if (!port) { setEdgeDraft(null); return; }

    if (!portsCompatible(edgeDraft.fromKind, port.type)) {
      setEdgeDraft(null);
      toast(`Can't connect ${edgeDraft.fromKind} → ${port.type}`);
      return;
    }
    if (edgeDraft.fromNode === nodeId) {
      setEdgeDraft(null);
      return;
    }
    // Append edge — for single ports this replaces any existing connection
    // to the same input; for multi-ports it just adds (deduping by source).
    setGraph((g) => ({
      ...g,
      edges: addEdgeRespectingMulti(
        g.edges,
        makeEdge(edgeDraft.fromNode, edgeDraft.fromPort, nodeId, portName),
        g,
      ),
    }));
    setEdgeDraft(null);
  }

  // ─────────────────────────────── Global pointermove/up
  // We use refs that mirror state so the window listeners never need to be
  // re-registered. Re-registering on every render would race with mid-drag
  // pointer events and cause edges/drags to drop.
  const rafPending = useRef(false);
  const lastPointer = useRef<{ x: number; y: number } | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const edgeDraftRef = useRef<EdgeDraft | null>(null);
  const isPanningRef = useRef(false);
  const zoomRef = useRef(zoom);
  const screenToCanvasRef = useRef(screenToCanvas);

  // Mirror graph into a ref so the always-mounted pointer listeners can read
  // the current nodes (e.g. marquee hit-testing) without re-registering.
  const graphRef = useRef(graph);
  useEffect(() => { graphRef.current = graph; }, [graph]);

  // ─────────────────────────────── Undo / redo
  // History of full graph snapshots. We only record STRUCTURAL changes
  // (node id/type/position/config, edges, groups) — volatile run state
  // (status spinners, outputs/results) is ignored so running a node doesn't
  // flood the undo stack. Undo/redo restore the full snapshot.
  const undoStack = useRef<Graph[]>([]);
  const redoStack = useRef<Graph[]>([]);
  const isUndoRedo = useRef(false);
  const prevGraphRef = useRef<Graph>(graph);
  const prevSnapRef = useRef<string>("");
  function structuralSnapshot(g: Graph): string {
    return JSON.stringify({
      nodes: g.nodes.map((n) => ({ id: n.id, type: n.type, position: n.position, config: n.config })),
      edges: g.edges,
      groups: g.groups ?? [],
    });
  }
  useEffect(() => {
    // initialize on first run
    if (prevSnapRef.current === "") {
      prevSnapRef.current = structuralSnapshot(graph);
      prevGraphRef.current = graph;
      return;
    }
    const snap = structuralSnapshot(graph);
    if (isUndoRedo.current) {
      // change came from undo/redo itself — don't record it
      isUndoRedo.current = false;
      prevSnapRef.current = snap;
      prevGraphRef.current = graph;
      return;
    }
    if (snap !== prevSnapRef.current) {
      undoStack.current.push(prevGraphRef.current);
      if (undoStack.current.length > 60) undoStack.current.shift();
      redoStack.current = []; // a fresh edit invalidates the redo chain
      prevSnapRef.current = snap;
      prevGraphRef.current = graph;
    }
  }, [graph]);

  const undo = useCallback(() => {
    if (undoStack.current.length === 0) return;
    const prev = undoStack.current.pop()!;
    redoStack.current.push(graphRef.current);
    isUndoRedo.current = true;
    setGraph(prev);
  }, []);
  const redo = useCallback(() => {
    if (redoStack.current.length === 0) return;
    const next = redoStack.current.pop()!;
    undoStack.current.push(graphRef.current);
    isUndoRedo.current = true;
    setGraph(next);
  }, []);

  // Refresh measured node heights after the graph changes (add/remove/config
  // can change a node's rendered height). Done on the next frame so the DOM
  // has painted. Feeds group-box bounds + auto-organize.
  useEffect(() => {
    const id = requestAnimationFrame(() => setNodeHeights(measureNodeHeights()));
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph.nodes]);

  // Keep refs in sync with state
  useEffect(() => { dragRef.current = drag; }, [drag]);
  useEffect(() => { edgeDraftRef.current = edgeDraft; }, [edgeDraft]);
  useEffect(() => { isPanningRef.current = isPanning; }, [isPanning]);
  useEffect(() => { zoomRef.current = zoom; }, [zoom]);
  useEffect(() => { screenToCanvasRef.current = screenToCanvas; }, [screenToCanvas]);

  useEffect(() => {
    function applyDrag() {
      rafPending.current = false;
      const ptr = lastPointer.current;
      if (!ptr) return;
      const drag = dragRef.current;
      const edgeDraft = edgeDraftRef.current;
      const isPanning = isPanningRef.current;
      const zoom = zoomRef.current;
      const screenToCanvas = screenToCanvasRef.current;
      if (drag) {
        const dx = (ptr.x - drag.pointerX) / zoom;
        const dy = (ptr.y - drag.pointerY) / zoom;
        // Move every node in the drag group (single-node drag = group of 1).
        const group = drag.group ?? [
          { nodeId: drag.nodeId, startX: drag.startX, startY: drag.startY },
        ];
        const livePositions = new Map<string, { x: number; y: number }>();
        for (const gi of group) {
          const nx = gi.startX + dx;
          const ny = gi.startY + dy;
          livePositions.set(gi.nodeId, { x: nx, y: ny });
          const el = document.querySelector(`[data-node-id="${gi.nodeId}"]`) as HTMLElement | null;
          if (el) el.style.transform = `translate(${nx}px, ${ny}px)`;
        }
        liveDragPos.current = livePositions.get(drag.nodeId) ?? null;
        liveDragPositions.current = livePositions;
        // Edges still need re-render but it's cheap — they're SVG paths.
        setDragTick((t) => t + 1);
      }
      if (edgeDraft) {
        const pt = screenToCanvas(ptr.x, ptr.y);
        setEdgeDraft((d) => (d ? { ...d, x2: pt.x, y2: pt.y } : d));
      }
      if (isPanning && panStart.current) {
        setPan({
          x: panStart.current.panX + (ptr.x - panStart.current.x),
          y: panStart.current.panY + (ptr.y - panStart.current.y),
        });
      }
      if (marqueeRef.current) {
        const pt = screenToCanvas(ptr.x, ptr.y);
        const next = { ...marqueeRef.current, x2: pt.x, y2: pt.y };
        marqueeRef.current = next;
        setMarquee(next);
      }
    }

    function onMove(e: PointerEvent) {
      lastPointer.current = { x: e.clientX, y: e.clientY };
      const hasAction =
        dragRef.current || edgeDraftRef.current || isPanningRef.current || marqueeRef.current;
      if (!rafPending.current && hasAction) {
        rafPending.current = true;
        requestAnimationFrame(applyDrag);
      }
    }
    function onUp(e: PointerEvent) {
      const drag = dragRef.current;
      const edgeDraft = edgeDraftRef.current;
      const isPanning = isPanningRef.current;
      const screenToCanvas = screenToCanvasRef.current;
      if (drag) {
        // Commit final positions of ALL dragged nodes to graph state.
        const livePositions = liveDragPositions.current;
        if (livePositions && livePositions.size > 0) {
          setGraph((g) => ({
            ...g,
            nodes: g.nodes.map((n) => {
              const p = livePositions.get(n.id);
              return p ? { ...n, position: { x: p.x, y: p.y } } : n;
            }),
          }));
        }
        liveDragPos.current = null;
        liveDragPositions.current = null;
        setDrag(null);
      }
      if (edgeDraft) {
        // 1. Direct hit on an input port — let the port's own pointerup handler take it.
        const target = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
        const portEl = target?.closest?.("[data-port-side]");
        if (portEl?.getAttribute("data-port-side") === "in") {
          setEdgeDraft(null);
          return;
        }

        // 2. SNAP: find the nearest input port within radius and connect to it.
        // 14px circles are tiny — being lenient here makes connection feel much
        // better. We search across the whole document; the snap radius is in
        // viewport pixels.
        const SNAP_RADIUS_PX = 40;
        let bestNodeId: string | null = null;
        let bestPortId: string | null = null;
        let bestPortKind: string | null = null;
        let bestDist = SNAP_RADIUS_PX;
        document.querySelectorAll<HTMLElement>('[data-port-side="in"]').forEach((el) => {
          const nodeEl = el.closest<HTMLElement>("[data-node-id]");
          const nodeId = nodeEl?.getAttribute("data-node-id");
          const portId = el.getAttribute("data-port-id");
          const kind = el.getAttribute("data-port-kind");
          if (!nodeId || !portId || !kind) return;
          if (nodeId === edgeDraft.fromNode) return; // can't connect to self
          const r = el.getBoundingClientRect();
          const dx = r.left + r.width / 2 - e.clientX;
          const dy = r.top + r.height / 2 - e.clientY;
          const dist = Math.hypot(dx, dy);
          if (dist < bestDist) {
            bestDist = dist;
            bestNodeId = nodeId;
            bestPortId = portId;
            bestPortKind = kind;
          }
        });

        if (
          bestNodeId &&
          bestPortId &&
          bestPortKind &&
          portsCompatible(edgeDraft.fromKind, bestPortKind as never)
        ) {
          const snappedNodeId = bestNodeId;
          const snappedPortId = bestPortId;
          setGraph((g) => ({
            ...g,
            edges: addEdgeRespectingMulti(
              g.edges,
              makeEdge(edgeDraft.fromNode, edgeDraft.fromPort, snappedNodeId, snappedPortId),
              g,
            ),
          }));
          setEdgeDraft(null);
          return;
        }

        // 3. No port nearby — fall back to ConnectionPicker (pick a new node from menu).
        const pt = screenToCanvas(e.clientX, e.clientY);
        setConnPicker({
          screenX: e.clientX,
          screenY: e.clientY,
          canvasX: pt.x,
          canvasY: pt.y,
          fromNode: edgeDraft.fromNode,
          fromPort: edgeDraft.fromPort,
          fromKind: edgeDraft.fromKind,
        });
        setEdgeDraft(null);
      }
      if (isPanning) {
        setIsPanning(false);
        panStart.current = null;
      }
      if (marqueeRef.current) {
        const m = marqueeRef.current;
        marqueeRef.current = null;
        setMarquee(null);
        const minX = Math.min(m.x1, m.x2);
        const maxX = Math.max(m.x1, m.x2);
        const minY = Math.min(m.y1, m.y2);
        const maxY = Math.max(m.y1, m.y2);
        // Ignore tiny marquees (treated as a plain click / deselect).
        if (Math.abs(maxX - minX) < 6 && Math.abs(maxY - minY) < 6) return;
        const additive = e.shiftKey || e.metaKey || e.ctrlKey;
        // A node is selected if its box intersects the marquee rect.
        const hit = new Set<string>();
        for (const n of graphRef.current.nodes) {
          const nx1 = n.position.x;
          const ny1 = n.position.y;
          const nx2 = n.position.x + NODE_WIDTH;
          const ny2 = n.position.y + 90; // representative node height
          const intersects = nx1 < maxX && nx2 > minX && ny1 < maxY && ny2 > minY;
          if (intersects) hit.add(n.id);
        }
        setSelectedIds((prev) => {
          if (!additive) return hit;
          const next = new Set(prev);
          for (const id of hit) next.add(id);
          return next;
        });
      }
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    // Listeners are registered ONCE on mount — state is read via refs above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─────────────────────────────── Keyboard shortcuts
  const clipboard = useRef<GraphNode | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // Ignore when typing in input/textarea
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      const meta = e.metaKey || e.ctrlKey;

      // Undo / Redo. ⌘/Ctrl+Z = undo, ⌘/Ctrl+Shift+Z or Ctrl+Y = redo.
      if (meta && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (meta && e.key.toLowerCase() === "y") {
        e.preventDefault();
        redo();
        return;
      }

      // Delete / Backspace → delete ALL selected nodes
      if ((e.key === "Delete" || e.key === "Backspace") && selectedIds.size > 0 && !expandedNodeId) {
        e.preventDefault();
        deleteSelected();
        return;
      }

      // Escape → clear selection, close menus
      if (e.key === "Escape") {
        setSelected(null);
        setCtxMenu(null);
        setConnPicker(null);
        return;
      }

      // Cmd/Ctrl+A → select all nodes
      if (meta && e.key.toLowerCase() === "a") {
        e.preventDefault();
        setSelectedIds(new Set(graph.nodes.map((n) => n.id)));
        return;
      }

      // Cmd/Ctrl+C → copy selected node to clipboard
      if (meta && e.key.toLowerCase() === "c" && selected) {
        e.preventDefault();
        const n = graph.nodes.find((x) => x.id === selected);
        if (n) clipboard.current = n;
        return;
      }

      // Cmd/Ctrl+V → paste clipboard node at offset
      if (meta && e.key.toLowerCase() === "v" && clipboard.current) {
        e.preventDefault();
        const src = clipboard.current;
        const newNode = makeNode(src.type, { x: src.position.x + 30, y: src.position.y + 30 });
        newNode.config = JSON.parse(JSON.stringify(src.config));
        setGraph((g) => ({ ...g, nodes: [...g.nodes, newNode] }));
        setSelected(newNode.id);
        return;
      }

      // Cmd/Ctrl+D → duplicate. Group (if the selection exactly matches a
      // group) → duplicate the whole group; multi-selection → duplicate all;
      // single node → duplicate it.
      if (meta && e.key.toLowerCase() === "d" && selectedIds.size > 0) {
        e.preventDefault();
        const grp = (graph.groups ?? []).find(
          (gr) => gr.nodeIds.length === selectedIds.size && gr.nodeIds.every((id) => selectedIds.has(id)),
        );
        if (grp) {
          duplicateGroup(grp.id);
        } else if (selectedIds.size > 1) {
          duplicateSelection();
        } else if (selected) {
          const src = graph.nodes.find((x) => x.id === selected);
          if (src) {
            const newNode = makeNode(src.type, { x: src.position.x + 30, y: src.position.y + 30 });
            newNode.config = JSON.parse(JSON.stringify(src.config));
            setGraph((g) => ({ ...g, nodes: [...g.nodes, newNode] }));
            setSelected(newNode.id);
          }
        }
        return;
      }

      // Cmd/Ctrl+Enter → run selected node
      if (meta && e.key === "Enter" && selected) {
        e.preventDefault();
        startRun(selected);
        return;
      }

      // Cmd/Ctrl+G → group selection · Cmd/Ctrl+Shift+G → ungroup
      if (meta && e.key.toLowerCase() === "g") {
        e.preventDefault();
        if (e.shiftKey) ungroupSelected();
        else groupSelected();
        return;
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [selected, selectedIds, expandedNodeId, deleteNode, deleteSelected, groupSelected, ungroupSelected, duplicateGroup, duplicateSelection, undo, redo, graph.nodes, graph.groups, ]);

  // ─────────────────────────────── Pan & background interaction
  function onCanvasPointerDown(e: React.PointerEvent) {
    // Middle-click, alt+left, or Space+left always pans (Figma-style escape
    // hatch — works anywhere, even on top of nodes).
    if (e.button === 1 || (e.button === 0 && (e.altKey || spaceHeld))) {
      setIsPanning(true);
      panStart.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
      return;
    }
    // Right-click: context menu (handled by onCanvasContextMenu below).
    if (e.button === 2) return;
    // Marquee on empty field = anywhere NOT on a node, port, group box, or
    // interactive control. Previously this only fired on the exact bg layer,
    // which the transform container covered — so most of the canvas didn't
    // respond. closest() covers the whole free area.
    const t = e.target as HTMLElement;
    const onInteractive =
      t.closest("[data-node-id]") ||
      t.closest("[data-port-side]") ||
      t.closest("[data-group-box]") ||
      t.closest("button, input, textarea, select, a");
    if (!onInteractive) {
      const additive = e.shiftKey || e.metaKey || e.ctrlKey;
      if (!additive) setSelected(null);
      const pt = screenToCanvas(e.clientX, e.clientY);
      marqueeRef.current = { x1: pt.x, y1: pt.y, x2: pt.x, y2: pt.y };
      setMarquee(marqueeRef.current);
    }
  }

  function onCanvasContextMenu(e: React.MouseEvent) {
    const t = e.target as HTMLElement;
    // Input fields → let the browser's native menu (copy/paste/etc.) show.
    // Do NOT preventDefault here. (#10)
    if (t.closest("input, textarea, select, [contenteditable]")) {
      return;
    }
    e.preventDefault();
    // Right-click on a node → node action menu.
    const nodeEl = t.closest("[data-node-id]") as HTMLElement | null;
    if (nodeEl) {
      const nodeId = nodeEl.getAttribute("data-node-id");
      if (nodeId) {
        // If right-clicking a node that's not in a multi-selection, select
        // it; but keep an existing multi-selection so "Group" stays available.
        if (!selectedIds.has(nodeId) && selectedIds.size <= 1) setSelected(nodeId);
        setActionMenu({ x: e.clientX, y: e.clientY, kind: "node", id: nodeId });
        return;
      }
    }
    // Right-click on a group box → group action menu.
    const groupEl = t.closest("[data-group-box]") as HTMLElement | null;
    if (groupEl) {
      const groupId = groupEl.getAttribute("data-group-box");
      if (groupId) {
        setActionMenu({ x: e.clientX, y: e.clientY, kind: "group", id: groupId });
        return;
      }
    }
    // Empty canvas → node picker (add a node here).
    const pt = screenToCanvas(e.clientX, e.clientY);
    setCtxMenu({ x: e.clientX, y: e.clientY, canvasX: pt.x, canvasY: pt.y });
  }

  // Wheel/trackpad pan + zoom — must use native non-passive listener
  // so we can preventDefault and stop the page from scrolling.
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;

    function onWheel(e: WheelEvent) {
      if (!el) return;
      // Figma/Miro behaviour, no toggles needed:
      //   • Cmd/Ctrl + scroll → zoom (also triggered by trackpad pinch — the
      //     browser sets ctrlKey=true synthetically on pinch gestures).
      //   • Plain two-finger scroll → pan (both axes via deltaX/deltaY).
      //   • Mouse wheel (no modifier) → pan vertically. If you want to zoom
      //     with a mouse wheel, hold Cmd/Ctrl. This matches Figma exactly.
      const wantsZoom = e.ctrlKey || e.metaKey;
      if (wantsZoom) {
        e.preventDefault();
        const rect = el.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;
        const factor = Math.exp(-e.deltaY * 0.0015);
        setZoom((curZ) => {
          const newZ = Math.max(0.3, Math.min(2.5, curZ * factor));
          setPan((curP) => {
            const worldX = (mouseX - curP.x) / curZ;
            const worldY = (mouseY - curP.y) / curZ;
            return { x: mouseX - worldX * newZ, y: mouseY - worldY * newZ };
          });
          return newZ;
        });
        return;
      }
      // Bare scroll → pan in both directions. preventDefault stops the page
      // from scrolling under us.
      e.preventDefault();
      setPan((p) => ({ x: p.x - e.deltaX, y: p.y - e.deltaY }));
    }

    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);


  // ─────────────────────────────── File upload helper (used by upload nodes)
  // Direct-to-Supabase upload: the file bytes go STRAIGHT from the browser
  // into Supabase Storage via a one-time signed URL, bypassing our
  // serverless route (and its ~4.5MB body limit). Uses a raw XHR PUT so we
  // get upload progress events (supabase-js uploadToSignedUrl gives no
  // progress). Three steps: (1) signed upload URL, (2) PUT directly to
  // Supabase with progress, (3) finalize — register Asset + download URL.
  async function uploadFile(
    file: File,
    onProgress?: (pct: number) => void,
  ): Promise<{ cdnUrl: string }> {
    const ext = file.name.split(".").pop()?.toLowerCase() ?? "bin";

    // (1) signed upload URL
    const signedRes = await fetch("/api/upload/signed-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ext,
        brandId: workflowMeta.brandId,
        projectId: workflowMeta.projectId,
        workflowId,
      }),
    });
    if (!signedRes.ok) {
      throw new Error(`Could not start upload (${signedRes.status})`);
    }
    const { path, signedUrl } = (await signedRes.json()) as {
      bucket: string;
      path: string;
      token: string;
      signedUrl: string;
    };

    // (2) PUT directly to Supabase with progress. The signed upload URL
    // accepts a PUT with the raw file body; token is embedded in the URL,
    // so no auth header is needed. x-upsert mirrors uploadToSignedUrl.
    await new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", signedUrl, true);
      xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
      xhr.setRequestHeader("x-upsert", "true");
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && onProgress) {
          onProgress(Math.round((e.loaded / e.total) * 100));
        }
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve();
        else {
          // Supabase returns 413 (sometimes wrapped in a 400 body) when the
          // file exceeds the PROJECT-level upload size limit (50MB on the
          // free plan — a Supabase setting, not something the app controls).
          const txt = xhr.responseText ?? "";
          const isTooLarge =
            xhr.status === 413 ||
            txt.includes('"statusCode":"413"') ||
            txt.toLowerCase().includes("payload too large") ||
            txt.toLowerCase().includes("exceeded the maximum");
          reject(
            new Error(
              isTooLarge
                ? "File exceeds your Supabase upload limit (50MB on the free plan). " +
                  "Raise it in Supabase Dashboard → Project Settings → Storage → " +
                  "“Upload file size limit” (Pro plan needed above 50MB), or compress the video."
                : `Upload failed (${xhr.status})${txt ? `: ${txt.slice(0, 160)}` : ""}`,
            ),
          );
        }
      };
      xhr.onerror = () => reject(new Error("Upload network error"));
      xhr.send(file);
    });

    // (3) finalize — Asset row + signed download URL
    const finRes = await fetch("/api/upload/finalize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        storagePath: path,
        mime: file.type || "application/octet-stream",
        sizeBytes: file.size,
        brandId: workflowMeta.brandId,
        projectId: workflowMeta.projectId,
      }),
    });
    if (!finRes.ok) {
      throw new Error(`Could not finalize upload (${finRes.status})`);
    }
    const { cdnUrl } = (await finRes.json()) as { cdnUrl: string };
    return { cdnUrl };
  }

  // ─────────────────────────────── Run execution
  // Track which scope nodes have an in-flight run so we don't start a duplicate
  // when the user accidentally double-clicks or clicks again while a run is going.
  const inflightScopes = useRef<Set<string>>(new Set());

  async function startRun(scopeNodeId?: string) {
    const scopeKey = scopeNodeId ?? "__all__";
    if (inflightScopes.current.has(scopeKey)) {
      console.log("[FlowLab] startRun: ignoring duplicate for scope", scopeKey);
      return;
    }
    inflightScopes.current.add(scopeKey);
    console.log("[FlowLab] startRun called", { scopeNodeId, nodeCount: graph.nodes.length });
    setIsRunning(true);
    // Reset node statuses in scope. Note: for single-node runs, only reset that node + downstream chain.
    // Upstream nodes keep their cached outputs (server-side executor will reuse them).
    setGraph((g) => ({
      ...g,
      nodes: g.nodes.map((n) =>
        scopeNodeId && n.id !== scopeNodeId
          ? n
          : { ...n, status: "running", outputs: undefined, error: undefined, results: undefined },
      ),
    }));

    try {
      const cleaned: Graph = {
        nodes: graph.nodes.map((n) => ({ id: n.id, type: n.type, position: n.position, config: n.config, outputs: n.outputs, results: n.results })),
        edges: graph.edges,
      };
      console.log("[FlowLab] sending POST /api/runs/start", { workflowId, scope: scopeNodeId });
      const res = await fetch("/api/runs/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workflowId, graph: cleaned, scope: scopeNodeId }),
      });
      console.log("[FlowLab] /api/runs/start responded", res.status);
      if (!res.ok) {
        const errTxt = await res.text().catch(() => "");
        throw new Error(`Run failed to start: ${res.status} ${errTxt.slice(0, 200)}`);
      }
      const { runId } = (await res.json()) as { runId: string };

      const scopeName = scopeNodeId
        ? NODE_TYPES[graph.nodes.find((n) => n.id === scopeNodeId)?.type ?? ""]?.name ?? "subgraph"
        : "Run all";

      // Add to runs panel as running
      setRuns((rs) => [
        {
          id: runId,
          name: scopeName,
          status: "running",
          startedAt: Date.now(),
          steps: [],
          scopeNodeId,
        },
        ...rs.slice(0, 19),
      ]);

      // Begin polling
      pollRun(runId, scopeKey);

      // Tell the global active-runs store to refetch right now, so the
      // TopNav indicator pops in within ~100ms instead of waiting up to 5s.
      pokeActiveRuns();
    } catch (err) {
      console.error(err);
      // Reset the scoped nodes back to idle so user can retry
      setGraph((g) => ({
        ...g,
        nodes: g.nodes.map((n) =>
          scopeNodeId && n.id !== scopeNodeId ? n : { ...n, status: "error", error: err instanceof Error ? err.message : "Run failed" },
        ),
      }));
      inflightScopes.current.delete(scopeKey);
      if (activeRunPoll.current.size === 0) setIsRunning(false);
      toast("Run failed: " + (err instanceof Error ? err.message : "Unknown error"));
    }
  }

  async function stopRun(runId: string) {
    try {
      await fetch(`/api/runs/${runId}/cancel`, { method: "POST" });
    } catch (err) {
      console.error("Stop failed:", err);
    }
    const interval = activeRunPoll.current.get(runId);
    if (interval) {
      clearInterval(interval);
      activeRunPoll.current.delete(runId);
    }
    setRuns((rs) => rs.map((r) => (r.id === runId ? { ...r, status: "cancelled" } : r)));
    if (activeRunPoll.current.size === 0) setIsRunning(false);
  }

  async function stopAllRuns() {
    const ids = Array.from(activeRunPoll.current.keys());
    for (const id of ids) {
      await stopRun(id);
    }
  }

  function pollRun(runId: string, scopeKey: string) {
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/runs/${runId}`, { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as {
          transient?: boolean;
          status: "pending" | "running" | "done" | "error" | "cancelled";
          totalCostUsd: number;
          errorMessage: string | null;
          startedAt: string;
          finishedAt: string | null;
          steps: {
            nodeId: string; nodeType: string; status: "pending" | "running" | "done" | "error";
            costUsd: number; outputData: Record<string, unknown> | null; errorMessage: string | null;
            assets: { cdnUrl: string; kind: string }[];
          }[];
        };
        // Transient DB hiccup on the server — keep current state, retry next tick.
        if (data.transient || !data.status) return;

        // Update node statuses & outputs
        setGraph((g) => ({
          ...g,
          nodes: g.nodes.map((n) => {
            const step = data.steps.find((s) => s.nodeId === n.id);
            if (!step) return n;
            const assets = step.assets ?? [];
            // If the API returned multiple assets — that's the canonical
            // multi-result list, use it. If only 0/1 — DON'T clobber any
            // existing `results` the node already has (server-persist may
            // have already saved a multi-URL results array into graph
            // before polling fired). Previously this set `results: undefined`
            // which wiped legit 4-image arrays after one polling tick.
            const newResults =
              assets.length > 1
                ? assets.map((a) => ({ value: a.cdnUrl, mime: a.kind }))
                : n.results;
            return {
              ...n,
              status: step.status,
              outputs: step.outputData ?? n.outputs,
              error: step.errorMessage ?? undefined,
              results: newResults,
            };
          }),
        }));

        // Update run summary
        setRuns((rs) =>
          rs.map((r) =>
            r.id === runId
              ? {
                  ...r,
                  status: data.status === "pending" ? "running" : data.status,
                  totalCostUsd: data.totalCostUsd,
                  finishedAt: data.finishedAt ? new Date(data.finishedAt).getTime() : undefined,
                  steps: data.steps.map((s) => ({
                    nodeId: s.nodeId,
                    nodeName: NODE_TYPES[s.nodeType]?.name ?? s.nodeType,
                    status: s.status,
                    costUsd: s.costUsd,
                  })),
                }
              : r,
          ),
        );

        if (data.status === "done" || data.status === "error" || data.status === "cancelled") {
          clearInterval(interval);
          activeRunPoll.current.delete(runId);
          inflightScopes.current.delete(scopeKey);
          if (activeRunPoll.current.size === 0) setIsRunning(false);
        }
      } catch (err) {
        console.error("Poll error:", err);
      }
    }, 4000);
    activeRunPoll.current.set(runId, interval);
  }

  // ─────────────────────────────── Render
  const expandedNode = expandedNodeId ? graph.nodes.find((n) => n.id === expandedNodeId) : null;

  return (
    <div className="flex flex-col h-full bg-bg">
      <CanvasToolbar
        workflowName={workflowName}
        saveState={saveState}
        isRunning={isRunning}
        runCount={runs.length}
        onRunAll={() => startRun()}
        onStopAll={() => stopAllRuns()}
        onBuildAI={() => setBuilderOpen(true)}
        brandSlug={workflowMeta.brandSlug}
        projectId={workflowMeta.projectId}
        workflowId={workflowId}
      />

      {builderOpen && (
        <WorkflowBuilderPanel
          brandHint={workflowMeta.brandSlug}
          onApply={applyBuiltGraph}
          onClose={() => setBuilderOpen(false)}
        />
      )}

      <div className="flex-1 flex min-h-0">
        <NodePalette
          onAdd={(type) => {
            // Place new node at center of viewport in canvas coords
            const rect = canvasRef.current?.getBoundingClientRect();
            if (!rect) return;
            const cx = (rect.width / 2 - pan.x) / zoom;
            const cy = (rect.height / 2 - pan.y) / zoom;
            addNodeAt(type, cx, cy);
          }}
        />

        <div
          ref={canvasRef}
          className="flex-1 relative overflow-hidden canvas-grid canvas-viewport"
          onPointerDown={onCanvasPointerDown}
          onContextMenu={onCanvasContextMenu}
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes("application/x-flowlab-asset")) {
              e.preventDefault();
              e.dataTransfer.dropEffect = "copy";
            }
          }}
          onDrop={(e) => {
            const raw = e.dataTransfer.getData("application/x-flowlab-asset");
            if (!raw) return;
            e.preventDefault();
            try {
              const { cdnUrl, kind } = JSON.parse(raw) as { cdnUrl: string; kind: string };
              const pt = screenToCanvas(e.clientX, e.clientY);
              addAssetNode(cdnUrl, kind, pt.x, pt.y);
            } catch {
              /* ignore malformed drop */
            }
          }}
          style={{
            cursor: isPanning
              ? "grabbing"
              : drag
                ? "grabbing"
                : spaceHeld
                  ? "grab"
                  : "default",
          }}
        >
          {/* Background hit area for selection-clear */}
          <div className="canvas-bg-hit absolute inset-0" />

          <div
            className="absolute"
            style={{
              left: pan.x,
              top: pan.y,
              width: STORAGE_AREA.width,
              height: STORAGE_AREA.height,
              transform: `scale(${zoom})`,
              transformOrigin: "0 0",
            }}
          >
            {/* Group boxes — drawn behind edges/nodes. Box is computed live
                from member positions so it follows drags & auto-organize. */}
            {(graph.groups ?? []).map((gr) => {
              const members = gr.nodeIds
                .map((id) => graph.nodes.find((n) => n.id === id))
                .filter((n): n is GraphNode => !!n);
              if (members.length === 0) return null;
              const PAD = 24;
              const LABEL_H = 26;
              const live = liveDragPositions.current;
              let minX = Infinity;
              let minY = Infinity;
              let maxX = -Infinity;
              let maxY = -Infinity;
              for (const n of members) {
                const p = (live && live.get(n.id)) || n.position;
                const h = nodeHeights.get(n.id) ?? 120;
                minX = Math.min(minX, p.x);
                minY = Math.min(minY, p.y);
                maxX = Math.max(maxX, p.x + NODE_WIDTH);
                maxY = Math.max(maxY, p.y + h);
              }
              const allSelected = members.every((n) => selectedIds.has(n.id));
              return (
                <GroupBox
                  key={gr.id}
                  group={gr}
                  rgb={groupRGB(gr.color)}
                  colorKeys={GROUP_COLOR_KEYS}
                  colorMap={GROUP_COLORS}
                  allSelected={allSelected}
                  spaceHeld={spaceHeld}
                  rect={{
                    left: minX - PAD,
                    top: minY - PAD - LABEL_H,
                    width: maxX - minX + PAD * 2,
                    height: maxY - minY + PAD * 2 + LABEL_H,
                  }}
                  onBoxPointerDown={(e) => startGroupDrag(gr.id, e)}
                  onRename={(label) => renameGroup(gr.id, label)}
                  onColor={(c) => setGroupColor(gr.id, c)}
                  onOrganize={() => organizeGroup(gr.id)}
                  onUngroup={() => ungroupGroup(gr.id)}
                  onDelete={() => deleteGroup(gr.id)}
                />
              );
            })}

            <CanvasEdges
              graph={graph}
              hoveredEdgeId={hoveredEdge}
              draftEdge={edgeDraft ? { x1: edgeDraft.x1, y1: edgeDraft.y1, x2: edgeDraft.x2, y2: edgeDraft.y2, color: PORT_COLORS[edgeDraft.fromKind] } : null}
              liveDragNodeId={drag?.nodeId ?? null}
              liveDragPos={liveDragPos.current}
              liveDragPositions={liveDragPositions.current}
              dragTick={dragTick}
              pan={pan}
              zoom={zoom}
              onHover={setHoveredEdge}
              onDelete={deleteEdge}
            />

            {/* Marquee rubber-band rectangle (canvas coords) */}
            {marquee && (
              <div
                className="absolute border border-brand bg-brand/10 pointer-events-none rounded-sm"
                style={{
                  left: Math.min(marquee.x1, marquee.x2),
                  top: Math.min(marquee.y1, marquee.y2),
                  width: Math.abs(marquee.x2 - marquee.x1),
                  height: Math.abs(marquee.y2 - marquee.y1),
                }}
              />
            )}
            {graph.nodes.map((node) => {
              // Compute upstream string-typed inputs for this node so the
              // CanvasNode can render a "← context preview" above the
              // textarea. We collect from EVERY incoming edge whose source
              // produced a string-typed output (text/prompt fields).
              const resolvedInputs: Record<string, string> = {};
              for (const edge of graph.edges) {
                if (edge.to.nodeId !== node.id) continue;
                const src = graph.nodes.find((n) => n.id === edge.from.nodeId);
                if (!src?.outputs) continue;
                const val = (src.outputs as Record<string, unknown>)[edge.from.port];
                if (typeof val === "string" && val.length > 0 && !val.startsWith("http")) {
                  // Concatenate if multi-port has multiple text contributors;
                  // separate with a blank line so the LLM treats them as
                  // distinct sources of context.
                  resolvedInputs[edge.to.port] = resolvedInputs[edge.to.port]
                    ? `${resolvedInputs[edge.to.port]}\n\n${val}`
                    : val;
                }
              }
              // Composer: resolve connected upstream outputs into an ordered track list
              let composerTracks: { kind: string; value: string; label: string }[] | undefined;
              if (node.type === "composer") {
                const incoming = graph.edges.filter((e) => e.to.nodeId === node.id);
                const items: { y: number; kind: string; value: string; label: string; section?: string }[] = [];
                const SECTION_TYPES: Record<string, string> = { hook: "Hook", body: "Body", packShot: "Packshot", cta: "CTA" };
                const SECTION_ORDER = ["Hook", "Body", "Packshot", "CTA"];
                const resolveNodeVals = (n: typeof graph.nodes[number], port: string, push: (v: unknown, pt: string) => void) => {
                  const d = NODE_TYPES[n.type];
                  const pt = d?.outputs.find((p) => p.name === port)?.type ?? "any";
                  if (n.results && n.results.length > 1) {
                    const idx = typeof n.config?._selectedResultIdx === "number" ? (n.config._selectedResultIdx as number) : -1;
                    if (n.type === "brandAssets") for (const r of n.results) push(r.value, pt);
                    else if (idx >= 0 && n.results[idx]) push(n.results[idx].value, pt);
                    else push(n.outputs?.[port], pt);
                  } else if (n.outputs && n.outputs[port] != null) push(n.outputs[port], pt);
                  else {
                    const cfg = n.config ?? {};
                    if (n.type === "uploadVideo" || n.type === "uploadAudio") push((cfg.cdnUrl as string) || (cfg.url as string), pt);
                    else if (n.type === "uploadImage") push(cfg.cdnUrl as string, pt);
                    else if (n.type === "brandAssets") { const sel = cfg.selected; if (Array.isArray(sel)) for (const u of sel) push(u as string, pt); }
                    else if (n.type === "yourText") push(cfg.text as string, pt);
                  }
                };
                for (const e of incoming) {
                  const from = graph.nodes.find((n) => n.id === e.from.nodeId);
                  if (!from) continue;
                  const fdef = NODE_TYPES[from.type];
                  if (from.type === "subtitles") {
                    const wj = from.outputs?.words;
                    if (typeof wj === "string" && wj.startsWith("[")) items.push({ y: from.position.y, kind: "captions", value: wj, label: "Subtitles" });
                    continue;
                  }
                  const portType = fdef?.outputs.find((p) => p.name === e.from.port)?.type ?? "any";
                  const section = SECTION_TYPES[from.type];
                  const label = (typeof from.config?.label === "string" && from.config.label) || fdef?.name || from.type;
                  const pushVal = (v: unknown, pt: string = portType, lbl: string = label) => {
                    if (typeof v !== "string" || !v) return;
                    const isUrl = v.startsWith("http");
                    let kind: string;
                    if (!isUrl) kind = "text";
                    else if (/\.(mp4|webm|mov|m4v)(\?|$)/i.test(v)) kind = "video";
                    else if (/\.(mp3|wav|m4a|aac|ogg|flac)(\?|$)/i.test(v)) kind = "audio";
                    else if (/\.(png|jpe?g|webp|gif|avif|svg)(\?|$)/i.test(v)) kind = "image";
                    else kind = pt === "any" || pt === "text" ? "image" : pt;
                    items.push({ y: from.position.y, kind, value: v, label: lbl, section });
                  };
                  if (section) {
                    // a structural section node: forward the materials wired INTO it, tagged with the section
                    for (const se of graph.edges.filter((x) => x.to.nodeId === from.id)) {
                      const src = graph.nodes.find((n) => n.id === se.from.nodeId);
                      if (!src) continue;
                      const srcLabel = NODE_TYPES[src.type]?.name || src.type;
                      resolveNodeVals(src, se.from.port, (v, pt) => pushVal(v, pt, `${section}: ${srcLabel}`));
                    }
                    continue;
                  }
                  if (from.results && from.results.length > 1) {
                    const idx = typeof from.config?._selectedResultIdx === "number" ? (from.config._selectedResultIdx as number) : -1;
                    if (from.type === "brandAssets") for (const r of from.results) pushVal(r.value);
                    else if (idx >= 0 && from.results[idx]) pushVal(from.results[idx].value);
                    else pushVal(from.outputs?.[e.from.port]);
                  } else if (from.outputs && from.outputs[e.from.port] != null) {
                    pushVal(from.outputs[e.from.port]);
                  } else {
                    // node never ran — fall back to its config (uploads, brand picks, raw text)
                    const cfg = from.config ?? {};
                    if (from.type === "uploadVideo" || from.type === "uploadAudio") pushVal((cfg.cdnUrl as string) || (cfg.url as string));
                    else if (from.type === "uploadImage") pushVal(cfg.cdnUrl as string);
                    else if (from.type === "brandAssets") { const sel = cfg.selected; if (Array.isArray(sel)) for (const u of sel) pushVal(u as string); }
                    else if (from.type === "yourText") pushVal(cfg.text as string);
                  }
                }
                items.sort((a, b) => {
                  const sa = a.section ? SECTION_ORDER.indexOf(a.section) : 99;
                  const sb = b.section ? SECTION_ORDER.indexOf(b.section) : 99;
                  return sa - sb || a.y - b.y;
                });
                composerTracks = items.map(({ kind, value, label, section }) => ({ kind, value, label, section }));
              }
              return (
              <CanvasNode
                key={node.id}
                node={node}
                edges={graph.edges}
                resolvedInputs={resolvedInputs}
                isSelected={selectedIds.has(node.id)}
                isRunning={isRunning}
                onPointerDown={(e) => startNodeDrag(node.id, e)}
                onOutputPortDown={(portId, e) => startEdge(node.id, portId, e)}
                onInputPortUp={(portId, e) => endEdgeOnInput(node.id, portId, e)}
                onSelect={(additive) => toggleSelect(node.id, additive)}
                onDelete={() => deleteNode(node.id)}
                onConfigChange={(k, v) => updateNodeConfig(node.id, k, v)}
                onRun={() => startRun(node.id)}
                onStop={() => {
                  // Find any active run that touches this node and cancel it
                  const targetRun = runs.find(
                    (r) => r.status === "running" && (r.scopeNodeId === node.id || !r.scopeNodeId),
                  );
                  if (targetRun) stopRun(targetRun.id);
                }}
                onExpand={() => setExpandedNodeId(node.id)}
                onUploadFile={uploadFile}
                workflowMeta={{ ...workflowMeta, workflowId }}
                composerTracks={composerTracks}
                editorHref={node.type === "composer" ? `/editor?wf=${workflowId}&proj=${workflowMeta.projectId}` : undefined}
                onStashTracks={node.type === "composer" ? () => {
                  try { localStorage.setItem(`flowlab.editor.import.v1:${workflowId}`, JSON.stringify({ tracks: composerTracks ?? [] })); } catch { /* */ }
                } : undefined}
              />
              );
            })}
          </div>

          {/* Empty hint */}
          {graph.nodes.length === 0 && (
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-center text-fg-subtle pointer-events-none">
              <div className="text-[13px] mb-2">Right-click on canvas to add a node</div>
              <div className="text-[11px]">…or pick from the palette on the left</div>
            </div>
          )}

          {/* Floating toolbar bottom-center: zoom + grid + fullscreen */}
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1 bg-bg-card border border-border rounded-full px-2 py-1 shadow-node">
            <button
              onClick={() => setZoom((z) => Math.max(0.4, z - 0.1))}
              className="w-7 h-7 rounded-full flex items-center justify-center hover:bg-bg-hover text-fg-muted group relative hover:text-fg"
              title="Zoom out"
            >
              <Minus size={12} />
              <span className="pointer-events-none absolute -top-8 left-1/2 -translate-x-1/2 px-1.5 py-0.5 rounded bg-bg-card border border-border text-[9px] text-fg whitespace-nowrap opacity-0 group-hover:opacity-100 transition shadow-node">Zoom out</span>
            </button>
            <span className="text-[10px] text-fg-muted px-1 tabular-nums">{Math.round(zoom * 100)}%</span>
            <button
              onClick={() => setZoom((z) => Math.min(2, z + 0.1))}
              className="w-7 h-7 rounded-full flex items-center justify-center hover:bg-bg-hover text-fg-muted group relative hover:text-fg"
              title="Zoom in"
            >
              <Plus size={12} />
              <span className="pointer-events-none absolute -top-8 left-1/2 -translate-x-1/2 px-1.5 py-0.5 rounded bg-bg-card border border-border text-[9px] text-fg whitespace-nowrap opacity-0 group-hover:opacity-100 transition shadow-node">Zoom in</span>
            </button>
            <div className="w-px h-4 bg-border mx-1" />
            <button
              onClick={undo}
              className="w-7 h-7 rounded-full flex items-center justify-center hover:bg-bg-hover text-fg-muted group relative hover:text-fg"
              title="Undo (⌘/Ctrl+Z)"
            >
              <Undo2 size={12} />
              <span className="pointer-events-none absolute -top-8 left-1/2 -translate-x-1/2 px-1.5 py-0.5 rounded bg-bg-card border border-border text-[9px] text-fg whitespace-nowrap opacity-0 group-hover:opacity-100 transition shadow-node">Undo</span>
            </button>
            <button
              onClick={redo}
              className="w-7 h-7 rounded-full flex items-center justify-center hover:bg-bg-hover text-fg-muted group relative hover:text-fg"
              title="Redo (⌘/Ctrl+Shift+Z)"
            >
              <Redo2 size={12} />
              <span className="pointer-events-none absolute -top-8 left-1/2 -translate-x-1/2 px-1.5 py-0.5 rounded bg-bg-card border border-border text-[9px] text-fg whitespace-nowrap opacity-0 group-hover:opacity-100 transition shadow-node">Redo</span>
            </button>
            <div className="w-px h-4 bg-border mx-1" />
            <button
              onClick={() => { setZoom(1); setPan({ x: 200, y: 100 }); }}
              className="w-7 h-7 rounded-full flex items-center justify-center hover:bg-bg-hover text-fg-muted group relative hover:text-fg"
              title="Reset view"
            >
              <Maximize size={11} />
              <span className="pointer-events-none absolute -top-8 left-1/2 -translate-x-1/2 px-1.5 py-0.5 rounded bg-bg-card border border-border text-[9px] text-fg whitespace-nowrap opacity-0 group-hover:opacity-100 transition shadow-node">Reset view</span>
            </button>
            <button
              onClick={organizeNodes}
              className="w-7 h-7 rounded-full flex items-center justify-center hover:bg-bg-hover text-fg-muted group relative hover:text-fg"
              title="Auto-organize (arrange nodes by flow)"
            >
              <Network size={12} />
              <span className="pointer-events-none absolute -top-8 left-1/2 -translate-x-1/2 px-1.5 py-0.5 rounded bg-bg-card border border-border text-[9px] text-fg whitespace-nowrap opacity-0 group-hover:opacity-100 transition shadow-node">Auto-organize</span>
            </button>
            <button
              onClick={() => setShowHelp((v) => !v)}
              className="w-7 h-7 rounded-full flex items-center justify-center hover:bg-bg-hover text-fg-muted group relative hover:text-fg"
              title="Keyboard shortcuts & gestures"
            >
              <HelpCircle size={12} />
              <span className="pointer-events-none absolute -top-8 left-1/2 -translate-x-1/2 px-1.5 py-0.5 rounded bg-bg-card border border-border text-[9px] text-fg whitespace-nowrap opacity-0 group-hover:opacity-100 transition shadow-node">Keyboard shortcuts & gestures</span>
            </button>
            <button
              onClick={() => setShowAssets((v) => !v)}
              className={`w-7 h-7 rounded-full flex items-center justify-center hover:bg-bg-hover group relative hover:text-fg ${
                showAssets ? "text-brand" : "text-fg-muted"
              }`}
              title="Asset library"
            >
              <Images size={12} />
              <span className="pointer-events-none absolute -top-8 left-1/2 -translate-x-1/2 px-1.5 py-0.5 rounded bg-bg-card border border-border text-[9px] text-fg whitespace-nowrap opacity-0 group-hover:opacity-100 transition shadow-node">Asset library</span>
            </button>
          </div>

          {showHelp && <HelpHints onClose={() => setShowHelp(false)} />}

          {showAssets && (
            <AssetDrawer
              onClose={() => setShowAssets(false)}
              brandId={workflowMeta.brandId}
              onPick={(a: AssetItem) => {
                // Click = drop at viewport center in canvas coords.
                const rect = canvasRef.current?.getBoundingClientRect();
                const cx = rect ? (rect.width / 2 - pan.x) / zoom : 400;
                const cy = rect ? (rect.height / 2 - pan.y) / zoom : 300;
                addAssetNode(a.cdnUrl, a.kind, cx, cy);
              }}
            />
          )}

          {/* Minimap — overview + click-to-navigate. Hidden when empty. */}
          {graph.nodes.length > 0 && (
            <Minimap
              nodes={graph.nodes}
              nodeWidth={NODE_WIDTH}
              pan={pan}
              zoom={zoom}
              viewportSize={viewportSize}
              onNavigate={setPan}
            />
          )}

          <RunsPanel runs={runs} />
        </div>
      </div>

      {/* Context menu */}
      {ctxMenu && (() => {
        // Capture coords in stable locals so even if React tears down ctxMenu state
        // between mousedown/click the values remain valid in the closure.
        const cx = ctxMenu.canvasX;
        const cy = ctxMenu.canvasY;
        return (
          <ContextMenu
            x={ctxMenu.x}
            y={ctxMenu.y}
            onClose={() => setCtxMenu(null)}
            onPick={(type) => {
              addNodeAt(type, cx, cy);
              setCtxMenu(null);
            }}
          />
        );
      })()}

      {/* Action menu (right-click on node / group) */}
      {actionMenu && (() => {
        const close = () => setActionMenu(null);
        let items: ActionItem[] = [];
        if (actionMenu.kind === "node") {
          const nodeId = actionMenu.id;
          const multi = selectedIds.size > 1;
          items = [
            { label: "Run", icon: <Play size={13} />, onClick: () => startRun(nodeId) },
            {
              label: "Duplicate",
              icon: <Copy size={13} />,
              onClick: () => {
                const src = graph.nodes.find((x) => x.id === nodeId);
                if (!src) return;
                const newNode = makeNode(src.type, { x: src.position.x + 30, y: src.position.y + 30 });
                newNode.config = JSON.parse(JSON.stringify(src.config));
                setGraph((g) => ({ ...g, nodes: [...g.nodes, newNode] }));
                setSelected(newNode.id);
              },
            },
          ];
          if (multi) {
            items.push({
              label: `Group ${selectedIds.size} nodes`,
              icon: <GroupIcon size={13} />,
              onClick: () => groupSelected(),
              separator: true,
            });
          }
          items.push({
            label: multi ? "Delete selected" : "Delete",
            icon: <Trash2 size={13} />,
            onClick: () => (multi ? deleteSelected() : deleteNode(nodeId)),
            danger: true,
            separator: true,
          });
        } else {
          const groupId = actionMenu.id;
          items = [
            {
              label: "Rename",
              icon: <Pencil size={13} />,
              onClick: () => {
                const gr = (graph.groups ?? []).find((x) => x.id === groupId);
                const name = window.prompt("Group name", gr?.label ?? "Group");
                if (name !== null) renameGroup(groupId, name.trim() || "Group");
              },
            },
            { label: "Organize nodes", icon: <Network size={13} />, onClick: () => organizeGroup(groupId) },
            { label: "Duplicate group", icon: <Copy size={13} />, onClick: () => duplicateGroup(groupId) },
            { label: "Select nodes", icon: <GroupIcon size={13} />, onClick: () => selectGroup(groupId) },
            { label: "Ungroup", icon: <Ungroup size={13} />, onClick: () => ungroupGroup(groupId), separator: true },
            { label: "Delete group + nodes", icon: <Trash2 size={13} />, onClick: () => deleteGroup(groupId), danger: true },
          ];
        }
        return <ActionMenu x={actionMenu.x} y={actionMenu.y} items={items} onClose={close} />;
      })()}

      {/* Connection picker */}
      {connPicker && (() => {
        // Capture in stable locals before any state changes invalidate connPicker.
        const cx = connPicker.canvasX;
        const cy = connPicker.canvasY;
        const fromNode = connPicker.fromNode;
        const fromPort = connPicker.fromPort;
        return (
          <ConnectionPicker
            x={connPicker.screenX}
            y={connPicker.screenY}
            sourceKind={connPicker.fromKind}
            onClose={() => setConnPicker(null)}
            onPick={(type, inputPort) => {
              addNodeAt(type, cx, cy, {
                connectFrom: { node: fromNode, port: fromPort },
                toInput: inputPort,
              });
              setConnPicker(null);
            }}
          />
        );
      })()}

      {/* Expanded modal */}
      {expandedNode && (
        <NodeExpandedModal
          node={expandedNode}
          isRunning={isRunning}
          onClose={() => setExpandedNodeId(null)}
          onConfigChange={(k, v) => updateNodeConfig(expandedNode.id, k, v)}
          onRun={() => {
            startRun(expandedNode.id);
            setExpandedNodeId(null);
          }}
        />
      )}
    </div>
  );
}

function toast(msg: string) {
  // Light-weight inline toast — replace with proper toast lib later
  const el = document.createElement("div");
  el.textContent = msg;
  el.className =
    "fixed top-16 left-1/2 -translate-x-1/2 z-[2000] bg-red-500 text-white text-[12px] px-4 py-2 rounded-md shadow-panel animate-fade-up";
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2400);
}
