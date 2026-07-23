"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  NODE_TYPES, PORT_COLORS, makeNode, makeEdge, portsCompatible, addEdgeRespectingMulti, LLM_MODELS, getActiveOutputs, isTextEntryTarget,
  type Graph, type GraphNode, type GraphEdge, type PortKind, type Group, EMPTY_GRAPH,
} from "@/lib/canvas/types";
import { getVideoModel, defaultModelForMode, clampDuration, type VideoMode } from "@/lib/canvas/videoModels";
import CanvasNode, { NODE_WIDTH, NODE_HEADER_HEIGHT, NODE_PORT_SPACING, PORT_CHIP, PORT_OUTSET } from "./CanvasNode";
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
import RunsPanel, { type RunSummary } from "./RunsPanel";
import { estimateCost } from "@/lib/fal/pricing";
import ActiveRunsBar from "./ActiveRunsBar";
import { pokeActiveRuns } from "../ActiveRunsIndicator";
import { saveWorkflowGraph } from "@/lib/actions";
import { autoLayout } from "@/lib/canvas/autoLayout";
import { Minus, Plus, Maximize, Sparkles, ArrowUp, Paperclip, X as XIcon, Grid3X3, Network, Play, Copy, Trash2, Group as GroupIcon, Ungroup, Pencil, HelpCircle, Undo2, Redo2, Images, RefreshCw } from "lucide-react";

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
  // Custom colors are stored as #rrggbb hex; presets by key.
  if (color && color.startsWith("#") && /^#[0-9a-fA-F]{6}$/.test(color)) {
    const r = parseInt(color.slice(1, 3), 16), g = parseInt(color.slice(3, 5), 16), b = parseInt(color.slice(5, 7), 16);
    return `${r} ${g} ${b}`;
  }
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
  projectSpentUsd = 0,
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
  projectSpentUsd?: number;
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
  // Estimated cost of one full run of the currently-built workflow (sum of
  // each generation node's estimated cost). Updates live as the graph changes.
  const workflowEstimateUsd = useMemo(() => {
    let sum = 0;
    for (const n of graph.nodes) {
      const cfg = (n.config ?? {}) as Record<string, unknown>;
      const model = String(cfg.model ?? "");
      if (!model) continue;
      const duration = Number(cfg.duration) || undefined;
      const numImages = Number(cfg.numResults ?? cfg.numImages ?? cfg.num_images) || undefined;
      sum += estimateCost(model, { duration, numImages, resolution: String(cfg.resolution ?? "") });
    }
    return sum;
  }, [graph.nodes]);
  // Estimated per-run cost of just the SELECTED nodes - the whole-board sum
  // is useless on big boards ("cost tracking is inconvenient" feedback).
  const selectionEstimateUsd = useMemo(() => {
    if (selectedIds.size === 0) return 0;
    let sum = 0;
    for (const n of graph.nodes) {
      if (!selectedIds.has(n.id)) continue;
      const cfg = (n.config ?? {}) as Record<string, unknown>;
      const model = String(cfg.model ?? "");
      if (!model) continue;
      const duration = Number(cfg.duration) || undefined;
      const numImages = Number(cfg.numResults ?? cfg.numImages ?? cfg.num_images) || undefined;
      sum += estimateCost(model, { duration, numImages, resolution: String(cfg.resolution ?? "") });
    }
    return sum;
  }, [graph.nodes, selectedIds]);
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
      // Sliders/checkboxes/buttons are NOT typing contexts (see isTextEntryTarget).
      if (isTextEntryTarget(e.target)) return;
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
  // True while the current drag started on a GROUP BOX header - moving a
  // whole group must not re-evaluate membership against other groups.
  const dragFromGroupBoxRef = useRef(false);
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
  // ─── Node trash (patch 332) ───────────────────────────────────────────────
  // Every deleted node lands here WITH its config/results and internal edges,
  // capped at 20 and persisted per workflow in localStorage. Undo restores
  // whole-graph snapshots; the trash covers the "I deleted that node an hour
  // ago and its prompt was better" case.
  const TRASH_KEY = `flowlab.trash.v1:${workflowId}`;
  const [trash, setTrash] = useState<{ node: GraphNode; edges: GraphEdge[]; at: number }[]>([]);
  const [trashOpen, setTrashOpen] = useState(false);
  // Edge routing style: smooth curves (default) or right-angle "electrical"
  // wiring. Per-user preference, persisted in localStorage.
  const [edgeStyle, setEdgeStyle] = useState<"curve" | "ortho">("curve");
  useEffect(() => {
    try { if (localStorage.getItem("flowlab.edgeStyle.v1") === "ortho") setEdgeStyle("ortho"); } catch { /* */ }
  }, []);
  const toggleEdgeStyle = () => setEdgeStyle((s) => {
    const next = s === "curve" ? "ortho" : "curve";
    try { localStorage.setItem("flowlab.edgeStyle.v1", next); } catch { /* */ }
    return next;
  });
  useEffect(() => {
    try { const raw = localStorage.getItem(TRASH_KEY); if (raw) setTrash(JSON.parse(raw)); } catch { /* */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [TRASH_KEY]);
  const pushTrash = useCallback((entries: { node: GraphNode; edges: GraphEdge[] }[]) => {
    if (!entries.length) return;
    setTrash((prev) => {
      const next = [...entries.map((e) => ({ ...e, at: Date.now() })), ...prev].slice(0, 20);
      try { localStorage.setItem(TRASH_KEY, JSON.stringify(next)); } catch { /* quota */ }
      return next;
    });
  }, [TRASH_KEY]);
  const restoreFromTrash = useCallback((at: number) => {
    setTrash((prev) => {
      const entry = prev.find((t) => t.at === at);
      if (!entry) return prev;
      setGraph((g) => {
        // Re-use the original id when free so old edges can reconnect; a
        // colliding id (e.g. restored twice) gets a fresh node id.
        const idTaken = g.nodes.some((n) => n.id === entry.node.id);
        const node: GraphNode = idTaken
          ? { ...entry.node, id: makeNode(entry.node.type, entry.node.position).id }
          : entry.node;
        const nodeIds = new Set([...g.nodes.map((n) => n.id), node.id]);
        const edges = idTaken ? [] : entry.edges.filter((e) =>
          nodeIds.has(e.from.nodeId) && nodeIds.has(e.to.nodeId) &&
          !g.edges.some((x) => x.id === e.id));
        return { ...g, nodes: [...g.nodes, { ...node, status: "idle" }], edges: [...g.edges, ...edges] };
      });
      const next = prev.filter((t) => t.at !== at);
      try { localStorage.setItem(TRASH_KEY, JSON.stringify(next)); } catch { /* */ }
      return next;
    });
  }, [TRASH_KEY]);

  const deleteNode = useCallback((nodeId: string) => {
    setGraph((g) => {
      const victim = g.nodes.find((n) => n.id === nodeId);
      if (victim) pushTrash([{ node: victim, edges: g.edges.filter((e) => e.from.nodeId === nodeId || e.to.nodeId === nodeId) }]);
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
  }, [expandedNodeId, pushTrash]);

  // Delete every selected node (and their edges) in one shot.
  const deleteSelected = useCallback(() => {
    const sel = selectedIdsRef.current;
    if (sel.size === 0) return;
    setGraph((g) => {
      pushTrash(g.nodes.filter((n) => sel.has(n.id)).map((n) => ({
        node: n,
        edges: g.edges.filter((e) => e.from.nodeId === n.id || e.to.nodeId === n.id),
      })));
      const nodes = g.nodes.filter((n) => !sel.has(n.id));
      return {
        nodes,
        edges: g.edges.filter((e) => !sel.has(e.from.nodeId) && !sel.has(e.to.nodeId)),
        groups: cleanGroups(g.groups, nodes),
      };
    });
    setSelectedIds(new Set());
  }, [pushTrash]);

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
      // Internal edges (both ends duplicated) are remapped to the copies.
      // Incoming edges from OUTSIDE the selection are replicated so each
      // duplicate is fed by the same upstream sources as its original
      // (duplicate a node and it stays wired to its inputs).
      const newEdges = [] as ReturnType<typeof makeEdge>[];
      for (const e of g.edges) {
        const fromDup = idMap.has(e.from.nodeId);
        const toDup = idMap.has(e.to.nodeId);
        if (fromDup && toDup) {
          newEdges.push(makeEdge(idMap.get(e.from.nodeId)!, e.from.port, idMap.get(e.to.nodeId)!, e.to.port));
        } else if (toDup) {
          newEdges.push(makeEdge(e.from.nodeId, e.from.port, idMap.get(e.to.nodeId)!, e.to.port));
        }
      }
      // Copies of GROUPED nodes join the same group - a duplicate landing
      // outside its group (and no way to pull it in) was a top annoyance.
      const groups = (g.groups ?? []).map((gr) => {
        const extra = gr.nodeIds.filter((id) => idMap.has(id)).map((id) => idMap.get(id)!);
        return extra.length ? { ...gr, nodeIds: [...gr.nodeIds, ...extra] } : gr;
      });
      requestAnimationFrame(() => setSelectedIds(new Set(newNodes.map((n) => n.id))));
      return { ...g, groups, nodes: [...g.nodes, ...newNodes], edges: [...g.edges, ...newEdges] };
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

  // Align a group's members in a single ROW (same Y, ordered by X) or a
  // single COLUMN (same X, ordered by Y). Complements auto-organize, which
  // does layered graph layout ("group aligns only vertically" feedback).
  const alignGroup = useCallback((groupId: string, dir: "row" | "column") => {
    const heights = measureNodeHeights();
    const GAP = 48;
    setGraph((g) => {
      const gr = (g.groups ?? []).find((x) => x.id === groupId);
      if (!gr) return g;
      const ids = new Set(gr.nodeIds);
      const members = g.nodes.filter((n) => ids.has(n.id));
      if (members.length < 2) return g;
      const originX = Math.min(...members.map((n) => n.position.x));
      const originY = Math.min(...members.map((n) => n.position.y));
      const pos = new Map<string, { x: number; y: number }>();
      if (dir === "row") {
        const sorted = [...members].sort((a, b) => a.position.x - b.position.x);
        let x = originX;
        for (const n of sorted) { pos.set(n.id, { x, y: originY }); x += NODE_WIDTH + GAP; }
      } else {
        const sorted = [...members].sort((a, b) => a.position.y - b.position.y);
        let y = originY;
        for (const n of sorted) { pos.set(n.id, { x: originX, y }); y += (heights.get(n.id) ?? 240) + GAP; }
      }
      return { ...g, nodes: g.nodes.map((n) => (pos.has(n.id) ? { ...n, position: pos.get(n.id)! } : n)) };
    });
  }, []);

  // Start dragging an entire group by its box — moves all member nodes.
  function startGroupDrag(groupId: string, e: React.PointerEvent) {
    const gr = (graph.groups ?? []).find((x) => x.id === groupId);
    if (!gr) return;
    dragFromGroupBoxRef.current = true;
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
    // Split/Generate Parts: when the mode or count changes, some partN outputs
    // may disappear — drop any edges leaving a now-hidden output port so we
    // don't keep invisible, dead connections.
    if (key === "mode" || key === "count") {
      setGraph((g) => {
        const n = g.nodes.find((x) => x.id === nodeId);
        if (!n) return g;
        const def = NODE_TYPES[n.type];
        const isPartNode = def === NODE_TYPES.textSplit || def?.outputs.every((p) => /^part\d+$/.test(p.name));
        if (!isPartNode) return g;
        const active = new Set(getActiveOutputs(def, n.config).map((p) => p.name));
        const keep = g.edges.filter((e) => !(e.from.nodeId === nodeId && !active.has(e.from.port)));
        return keep.length === g.edges.length ? g : { ...g, edges: keep };
      });
    }
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
    // Match CanvasEdges: chip centre Y = NODE_HEADER_HEIGHT + 14 + CHIP/2 + idx*SPACING;
    // output chip centre X sits PORT_OUTSET px beyond the node's right edge.
    const portYpx = NODE_HEADER_HEIGHT + 14 + PORT_CHIP / 2 + portIdx * NODE_PORT_SPACING;
    setEdgeDraft({
      fromNode: nodeId,
      fromPort: portName,
      fromKind: port.type,
      x1: node.position.x + NODE_WIDTH + PORT_OUTSET,
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
  // ─── Fresh-handler trampoline (patch 321) ────────────────────────────────
  // CanvasNode is memoised with a comparator that IGNORES callback props (a
  // deliberate drag-perf tradeoff). That means a node keeps whatever inline
  // lambdas it captured on ITS last re-render — and those close over stale
  // graph / pan / zoom / selection. Symptoms in the wild: connecting from an
  // unselected node did nothing until you clicked it first ("double click
  // attaches"), draft wires started away from the port after panning, and
  // Run could send an outdated graph snapshot. Every node callback now goes
  // through this ref, which is re-pointed on each render — even a stale
  // lambda lands on the freshest closures.
  const nodeHandlersRef = useRef<{
    startNodeDrag: (nodeId: string, e: React.PointerEvent) => void;
    removeResult: (nodeId: string, idx: number) => void;
    restoreHistory: (nodeId: string, url: string) => void;
    startEdge: (nodeId: string, portName: string, e: React.PointerEvent) => void;
    endEdgeOnInput: (nodeId: string, portName: string, e: React.PointerEvent) => void;
    toggleSelect: (nodeId: string, additive?: boolean) => void;
    deleteNode: (nodeId: string) => void;
    updateNodeConfig: (nodeId: string, key: string, value: unknown) => void;
    startRun: (nodeId?: string) => void;
    askAgent: (nodeId: string) => void;
    stopForNode: (nodeId: string) => void;
    expandNode: (nodeId: string) => void;
    stashTracks: (nodeId: string) => void;
  }>(null as never);

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
        // Commit final positions of ALL dragged nodes to graph state, then
        // re-evaluate group membership: dropping a node INSIDE a group's box
        // joins that group, dragging it OUT leaves it (whole-group drags via
        // the group box header skip this).
        const livePositions = liveDragPositions.current;
        const fromGroupBox = dragFromGroupBoxRef.current;
        dragFromGroupBoxRef.current = false;
        if (livePositions && livePositions.size > 0) {
          setGraph((g) => {
            const nodes = g.nodes.map((n) => {
              const p = livePositions.get(n.id);
              return p ? { ...n, position: { x: p.x, y: p.y } } : n;
            });
            let groups = g.groups ?? [];
            if (!fromGroupBox && groups.length > 0) {
              const PAD = 24, APPROX_H = 240;
              const heights = measureNodeHeights();
              const bboxOf = (gr: Group) => {
                const members = nodes.filter((n) => gr.nodeIds.includes(n.id) && !livePositions.has(n.id));
                if (members.length === 0) return null;
                return {
                  x1: Math.min(...members.map((n) => n.position.x)) - PAD,
                  y1: Math.min(...members.map((n) => n.position.y)) - PAD,
                  x2: Math.max(...members.map((n) => n.position.x + NODE_WIDTH)) + PAD,
                  y2: Math.max(...members.map((n) => n.position.y + (heights.get(n.id) ?? APPROX_H))) + PAD,
                };
              };
              for (const id of livePositions.keys()) {
                const n = nodes.find((x) => x.id === id);
                if (!n) continue;
                const cx = n.position.x + NODE_WIDTH / 2;
                const cy = n.position.y + (heights.get(id) ?? APPROX_H) / 2;
                const target = groups.find((gr) => {
                  const b = bboxOf(gr);
                  return b && cx >= b.x1 && cx <= b.x2 && cy >= b.y1 && cy <= b.y2;
                });
                groups = groups.map((gr) => {
                  const isMember = gr.nodeIds.includes(id);
                  if (target && gr.id === target.id) {
                    return isMember ? gr : { ...gr, nodeIds: [...gr.nodeIds, id] };
                  }
                  // Left this group's area (or joined another) - drop membership.
                  if (isMember) {
                    const b = bboxOf(gr);
                    const inside = b && cx >= b.x1 && cx <= b.x2 && cy >= b.y1 && cy <= b.y2;
                    if (!inside) return { ...gr, nodeIds: gr.nodeIds.filter((x) => x !== id) };
                  }
                  return gr;
                });
              }
              groups = groups.filter((gr) => gr.nodeIds.length > 0);
            }
            return { ...g, nodes, groups };
          });
        }
        liveDragPos.current = null;
        liveDragPositions.current = null;
        setDrag(null);
      }
      if (edgeDraft) {
        // NOTE: a drop DIRECTLY on the input chip never fires the chip's own
        // pointerup (the drag source holds pointer capture, so all pointer
        // events retarget to it). The snap search below handles that case
        // naturally - the distance to the chip centre is ~0.

        // SNAP: find the nearest input port within radius and connect to it.
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

        // 2b. MAGNETIC CONNECT: released anywhere ON a node's card → attach to
        // that node's nearest COMPATIBLE input port. Aiming at the 22px chip
        // was the number-one connection complaint ("grab any node, pull,
        // release — it should just snap"). The whole card is the target now.
        {
          const under = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
          const nodeEl = under?.closest<HTMLElement>("[data-node-id]") ?? null;
          const overNodeId = nodeEl?.getAttribute("data-node-id");
          if (nodeEl && overNodeId && overNodeId !== edgeDraft.fromNode) {
            let cardBest: { portId: string; dist: number } | null = null;
            nodeEl.querySelectorAll<HTMLElement>('[data-port-side="in"]').forEach((pe) => {
              const pid = pe.getAttribute("data-port-id");
              const kind = pe.getAttribute("data-port-kind");
              if (!pid || !kind || !portsCompatible(edgeDraft.fromKind, kind as never)) return;
              const r = pe.getBoundingClientRect();
              const dist = Math.hypot(r.left + r.width / 2 - e.clientX, r.top + r.height / 2 - e.clientY);
              if (!cardBest || dist < cardBest.dist) cardBest = { portId: pid, dist };
            });
            if (cardBest) {
              const snappedPortId = (cardBest as { portId: string }).portId;
              setGraph((g) => ({
                ...g,
                edges: addEdgeRespectingMulti(
                  g.edges,
                  makeEdge(edgeDraft.fromNode, edgeDraft.fromPort, overNodeId, snappedPortId),
                  g,
                ),
              }));
              setEdgeDraft(null);
              return;
            }
          }
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
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    // Listeners are registered ONCE on mount — state is read via refs above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─────────────────────────────── Keyboard shortcuts
  // Full-fidelity clipboard for THIS tab (survives project switches within
  // the SPA). localStorage is only the cross-tab transport and may reject
  // large payloads - it must never limit what pasting in-tab can do.
  const clipboard = useRef<{ nodes: GraphNode[]; edges: GraphEdge[] } | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // Ignore when typing in a text-entry element (input/textarea/
      // contentEditable) — EXCEPT Ctrl/Cmd+D: the Chrome bookmark dialog is
      // never what the user wants on the board, so duplicate works (and the
      // dialog is suppressed) even mid-typing. Sliders/checkboxes/buttons/
      // selects do not block hotkeys at all.
      if (isTextEntryTarget(e.target)) {
        if ((e.metaKey || e.ctrlKey) && e.code === "KeyD") {
          e.preventDefault();
          if (selectedIds.size > 0) {
            const grp = (graph.groups ?? []).find(
              (gr) => gr.nodeIds.length === selectedIds.size && gr.nodeIds.every((id) => selectedIds.has(id)),
            );
            if (grp) duplicateGroup(grp.id); else duplicateSelection();
          }
        }
        return;
      }

      const meta = e.metaKey || e.ctrlKey;

      // Undo / Redo. ⌘/Ctrl+Z = undo, ⌘/Ctrl+Shift+Z or Ctrl+Y = redo.
      if (meta && e.code === "KeyZ") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (meta && e.code === "KeyY") {
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
      if (meta && e.code === "KeyA") {
        e.preventDefault();
        setSelectedIds(new Set(graph.nodes.map((n) => n.id)));
        return;
      }

      // Cmd/Ctrl+C → copy selected node(s) + their internal edges to a
      // persistent clipboard (localStorage) so they can be pasted into ANY
      // project's canvas, not just this one.
      if (meta && e.code === "KeyC" && selectedIds.size > 0) {
        e.preventDefault();
        const ids = selectedIds;
        const nodes = graph.nodes.filter((x) => ids.has(x.id));
        const edges = graph.edges.filter((ed) => ids.has(ed.from.nodeId) && ids.has(ed.to.nodeId));
        clipboard.current = { nodes, edges };
        // Cross-tab copy via localStorage: strip huge config values (base64
        // data URLs from upload nodes) so the 5MB quota can't reject the
        // write - THAT was why multi-copy pasted only one node.
        try {
          const slim = nodes.map((n) => ({
            ...n,
            config: Object.fromEntries(Object.entries(n.config ?? {}).map(([k, v]) =>
              [k, typeof v === "string" && v.length > 100_000 ? "" : v])),
          }));
          localStorage.setItem("flowlab.clipboard.v1", JSON.stringify({ nodes: slim, edges, at: Date.now() }));
        } catch { /* quota - the in-memory clipboard still has everything */ }
        return;
      }

      // Cmd/Ctrl+V → paste clipboard (nodes + internal edges) at an offset.
      if (meta && e.code === "KeyV") {
        e.preventDefault();
        let payload: { nodes: GraphNode[]; edges: { from: { nodeId: string; port: string }; to: { nodeId: string; port: string } }[] } | null = null;
        // Prefer the in-memory clipboard (full fidelity, always complete);
        // localStorage only serves cross-tab pastes.
        if (clipboard.current?.nodes.length) payload = clipboard.current;
        else { try { const raw = localStorage.getItem("flowlab.clipboard.v1"); if (raw) payload = JSON.parse(raw); } catch { /* */ } }
        if (!payload || !payload.nodes?.length) return;
        // Paste into VIEW: centre the pasted group at the current viewport
        // centre, preserving relative layout. Pasting at source position+40
        // dropped nodes off-screen whenever the user had panned away (the
        // "pasted image appears outside the visible area" report).
        const rect = canvasRef.current?.getBoundingClientRect();
        const centre = rect
          ? screenToCanvas(rect.left + rect.width / 2, rect.top + rect.height / 2)
          : { x: 400, y: 300 };
        const xs = payload.nodes.map((n) => n.position?.x ?? 0);
        const ys = payload.nodes.map((n) => n.position?.y ?? 0);
        const bboxCx = (Math.min(...xs) + Math.max(...xs)) / 2;
        const bboxCy = (Math.min(...ys) + Math.max(...ys)) / 2;
        setGraph((g) => {
          const idMap = new Map<string, string>();
          const newNodes = payload!.nodes.map((src) => {
            const nn = makeNode(src.type, {
              x: (src.position?.x ?? 0) - bboxCx + centre.x,
              y: (src.position?.y ?? 0) - bboxCy + centre.y,
            });
            nn.config = JSON.parse(JSON.stringify(src.config ?? {}));
            idMap.set(src.id, nn.id);
            return nn;
          });
          const newEdges = (payload!.edges ?? [])
            .filter((ed) => idMap.has(ed.from.nodeId) && idMap.has(ed.to.nodeId))
            .map((ed) => makeEdge(idMap.get(ed.from.nodeId)!, ed.from.port, idMap.get(ed.to.nodeId)!, ed.to.port));
          requestAnimationFrame(() => setSelectedIds(new Set(newNodes.map((n) => n.id))));
          return { ...g, nodes: [...g.nodes, ...newNodes], edges: [...g.edges, ...newEdges] };
        });
        return;
      }

      // Cmd/Ctrl+D → duplicate. Group (if the selection exactly matches a
      // group) → duplicate the whole group; multi-selection → duplicate all;
      // single node → duplicate it.
      if (meta && e.code === "KeyD") {
        // Always eat Ctrl/Cmd+D on the board — even with nothing selected the
        // browser bookmark dialog is never what the user wants here.
        e.preventDefault();
        if (selectedIds.size === 0) return;
        const grp = (graph.groups ?? []).find(
          (gr) => gr.nodeIds.length === selectedIds.size && gr.nodeIds.every((id) => selectedIds.has(id)),
        );
        if (grp) {
          duplicateGroup(grp.id);
        } else {
          duplicateSelection();
        }
        return;
      }

      // Cmd/Ctrl+Enter → run the selection: one node or ALL selected nodes
      // as a single run (its layers execute in parallel).
      if (meta && e.key === "Enter" && selectedIds.size > 0) {
        e.preventDefault();
        startRun(selectedIds.size === 1 ? [...selectedIds][0] : [...selectedIds]);
        return;
      }

      // Cmd/Ctrl+G → group selection · Cmd/Ctrl+Shift+G → ungroup
      if (meta && e.code === "KeyG") {
        e.preventDefault();
        if (e.shiftKey) ungroupSelected();
        else groupSelected();
        return;
      }
    }
    // Capture phase: runs before any focused widget can stopPropagation the
    // event away - one less source of "hotkeys stopped working today".
    document.addEventListener("keydown", onKey, { capture: true });
    return () => document.removeEventListener("keydown", onKey, { capture: true });
  }, [selected, selectedIds, expandedNodeId, deleteNode, deleteSelected, groupSelected, ungroupSelected, duplicateGroup, duplicateSelection, undo, redo, graph.nodes, graph.edges, graph.groups, ]);

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
      t.closest("[data-overlay]") ||
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
    // Generated previews → native menu gives "Save image/video as..." — the
    // requested right-click download path.
    if (t.closest("[data-native-menu]")) {
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
      const wantsZoom = e.ctrlKey || e.metaKey;
      // UNIVERSAL list-scroll: if the pointer is over a scrollable element
      // inside a node (avatar grid, brand assets, voices, any long list), let
      // the browser scroll THAT list instead of panning the canvas. Walk up
      // from the event target to the canvas; if we hit an element that scrolls
      // in the wheel's direction and isn't already at its edge, bail out. This
      // works for every node automatically — no per-component wiring needed.
      if (!wantsZoom) {
        let n = e.target as HTMLElement | null;
        while (n && n !== el) {
          const st = getComputedStyle(n);
          const canY = (st.overflowY === "auto" || st.overflowY === "scroll") && n.scrollHeight > n.clientHeight;
          const canX = (st.overflowX === "auto" || st.overflowX === "scroll") && n.scrollWidth > n.clientWidth;
          if (canY) {
            const atTop = n.scrollTop <= 0;
            const atBottom = n.scrollTop + n.clientHeight >= n.scrollHeight - 1;
            if (!((e.deltaY < 0 && atTop) || (e.deltaY > 0 && atBottom))) return;
          }
          if (canX && e.deltaX !== 0) {
            const atLeft = n.scrollLeft <= 0;
            const atRight = n.scrollLeft + n.clientWidth >= n.scrollWidth - 1;
            if (!((e.deltaX < 0 && atLeft) || (e.deltaX > 0 && atRight))) return;
          }
          n = n.parentElement;
        }
      }
      // Figma/Miro behaviour, no toggles needed:
      //   • Cmd/Ctrl + scroll → zoom (also triggered by trackpad pinch — the
      //     browser sets ctrlKey=true synthetically on pinch gestures).
      //   • Plain two-finger scroll → pan (both axes via deltaX/deltaY).
      //   • Mouse wheel (no modifier) → pan vertically. If you want to zoom
      //     with a mouse wheel, hold Cmd/Ctrl. This matches Figma exactly.
      if (wantsZoom) {
        e.preventDefault();
        const rect = el.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;
        const factor = Math.exp(-e.deltaY * 0.0015);
        setZoom((curZ) => {
          const newZ = Math.max(0.05, Math.min(2.5, curZ * factor));
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

  // Import dropped/pasted media files as Upload nodes. Each file goes through the
  // same direct-to-Supabase upload, then an Upload node carrying the CDN URL is
  // dropped at `at` (or canvas centre), staggered when there are several.
  async function importFiles(files: File[], at?: { x: number; y: number }) {
    const media = files.filter((f) => /^(image|video|audio)\//.test(f.type));
    if (media.length === 0) return;
    let base = at;
    if (!base) {
      const rect = canvasRef.current?.getBoundingClientRect();
      base = rect ? screenToCanvas(rect.left + rect.width / 2, rect.top + rect.height / 2) : { x: 0, y: 0 };
    }
    for (let i = 0; i < media.length; i++) {
      const f = media[i];
      const kind = f.type.startsWith("video/") ? "video" : f.type.startsWith("audio/") ? "audio" : "image";
      try {
        const { cdnUrl } = await uploadFile(f);
        addAssetNode(cdnUrl, kind, base.x + i * 40, base.y + i * 40);
      } catch (err) {
        console.error("[FlowLab] file import failed", err);
      }
    }
  }
  // Ctrl/Cmd+V anywhere on the canvas pastes clipboard images/videos/audio as
  // Upload nodes (skipped while typing in a field, so paste-into-prompt still
  // works). Uses a ref so the listener binds once but always runs the latest fn.
  const importFilesRef = useRef(importFiles);
  importFilesRef.current = importFiles;
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const dt = e.clipboardData;
      if (!dt) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      const files: File[] = [];
      for (const item of Array.from(dt.items || [])) {
        if (item.kind === "file") { const f = item.getAsFile(); if (f) files.push(f); }
      }
      if (files.length === 0 && dt.files) for (const f of Array.from(dt.files)) files.push(f);
      const media = files.filter((f) => /^(image|video|audio)\//.test(f.type));
      if (media.length === 0) return;
      e.preventDefault();
      void importFilesRef.current(media);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, []);

  // ─────────────────────────────── Run execution
  // Track which scope nodes have an in-flight run so we don't start a duplicate
  // when the user accidentally double-clicks or clicks again while a run is going.
  const inflightScopes = useRef<Set<string>>(new Set());

  // Resolve everything wired into a composer node as an ordered track list.
  // Used by the composer's "Send tracks to editor" button AND the canvas
  // agent's send_to_editor tool.
  const buildComposerTracks = useCallback((nodeId: string): { kind: string; value: string; label: string; section?: string }[] => {
                const incoming = graph.edges.filter((e) => e.to.nodeId === nodeId);
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
                return items.map(({ kind, value, label, section }) => ({ kind, value, label, section }));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph]);

  // ===========================================================================
  // Canvas AI agent: same chat/loop pattern as the editor agent, but the
  // tools operate on the GRAPH (nodes, edges, configs, runs, send-to-editor).
  // ===========================================================================
  type CAgentAction = { tool: string; args?: Record<string, unknown> };
  type CAgentChip = { tool: string; ok: boolean; result: string };
  type CAgentMsg = { role: "user" | "assistant" | "tool"; content: string; chips?: CAgentChip[] };
  const AGENT_CHAT_KEY = `flowlab.canvasagent.v1:${workflowId || "scratch"}`;
  const [agentOpen, setAgentOpen] = useState(false);
  const [agentMin, setAgentMin] = useState(false);
  const [agentMsgs, setAgentMsgs] = useState<CAgentMsg[]>(() => {
    try { const raw = localStorage.getItem(AGENT_CHAT_KEY); const j = raw ? (JSON.parse(raw) as CAgentMsg[]) : []; return Array.isArray(j) ? j.slice(-60) : []; } catch { return []; }
  });
  useEffect(() => { try { localStorage.setItem(AGENT_CHAT_KEY, JSON.stringify(agentMsgs.slice(-60))); } catch { /* */ } }, [agentMsgs, AGENT_CHAT_KEY]);
  const [agentInput, setAgentInput] = useState("");
  const [agentBusy, setAgentBusy] = useState(false);
  const [agentFiles, setAgentFiles] = useState<{ name: string; url: string; kind: "video" | "image" | "audio" }[]>([]);
  const [agentUploading, setAgentUploading] = useState(false);
  const agentFileInputRef = useRef<HTMLInputElement | null>(null);
  const onAgentFiles = useCallback(async (files: FileList | null) => {
    if (!files || !files.length) return;
    setAgentUploading(true);
    try {
      for (const f of Array.from(files).slice(0, 8)) {
        const kind: "video" | "image" | "audio" = f.type.startsWith("image") ? "image" : f.type.startsWith("audio") ? "audio" : "video";
        try { const { cdnUrl } = await uploadFile(f); setAgentFiles((prev) => [...prev, { name: f.name, url: cdnUrl, kind }]); }
        catch { /* skip a failed file */ }
      }
    } finally { setAgentUploading(false); }
  }, []);
  const [agentModel, setAgentModel] = useState<string>(() => {
    try { const m = localStorage.getItem("flowlab.agent.model"); if (m && LLM_MODELS.some((x) => x.id === m)) return m; } catch { /* */ }
    return "anthropic/claude-sonnet-4.6";
  });
  useEffect(() => { try { localStorage.setItem("flowlab.agent.model", agentModel); } catch { /* */ } }, [agentModel]);
  const [agentPos, setAgentPos] = useState<{ x: number; y: number } | null>(null);
  const agentDragRef2 = useRef<{ dx: number; dy: number } | null>(null);
  const agentEndRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => { agentEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [agentMsgs, agentBusy]);
  const onAgentDragDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest("button,select,textarea")) return;
    const panel = (e.currentTarget as HTMLElement).parentElement!;
    const r = panel.getBoundingClientRect();
    agentDragRef2.current = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    if (!agentPos) setAgentPos({ x: r.left, y: r.top });
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  };
  const onAgentDragMove = (e: React.PointerEvent) => {
    const d = agentDragRef2.current; if (!d) return;
    const w = 360, m = 8;
    setAgentPos({ x: Math.min(Math.max(m, e.clientX - d.dx), window.innerWidth - w - m), y: Math.min(Math.max(m, e.clientY - d.dy), window.innerHeight - 56) });
  };
  const onAgentDragUp = () => { agentDragRef2.current = null; };

  const buildCanvasState = useCallback((): string => {
    const g = graphRef.current;
    const nodes = g.nodes.slice(0, 60).map((n) => {
      const d = NODE_TYPES[n.type];
      return {
        id: n.id, type: n.type, name: d?.name || n.type,
        ...(typeof n.config?.label === "string" && n.config.label ? { label: (n.config.label as string).slice(0, 24) } : {}),
        status: n.status || "idle",
        ports_in: (d?.inputs || []).map((p) => `${p.name}:${p.type}${p.multi ? "*" : ""}`).join(" "),
        ports_out: (d?.outputs || []).map((p) => `${p.name}:${p.type}`).join(" "),
        out: n.results?.length ? `${n.results.length} results` : n.outputs ? Object.keys(n.outputs).join(",").slice(0, 40) : "",
        x: Math.round(n.position.x), y: Math.round(n.position.y),
      };
    });
    const edges = g.edges.slice(0, 120).map((e) => `${e.from.nodeId}.${e.from.port} -> ${e.to.nodeId}.${e.to.port}`);
    const cats = Array.from(new Set(Object.values(NODE_TYPES).map((d) => d.category)));
    return JSON.stringify({ workflowId: workflowId || null, brand: workflowMeta.brandSlug || null, nodeTypeCategories: cats, nodes, edges });
  }, [workflowId, workflowMeta.brandSlug]);

  const executeCanvasAction = useCallback(async (a: CAgentAction): Promise<string> => {
    const args = a.args || {};
    const str = (k: string) => (typeof args[k] === "string" ? (args[k] as string) : undefined);
    const num = (k: string) => (typeof args[k] === "number" && isFinite(args[k] as number) ? (args[k] as number) : undefined);
    const nodeOf = (k = "node_id") => graphRef.current.nodes.find((n) => n.id === str(k));
    switch (a.tool) {
      case "list_node_types": {
        const cat = str("category"); const q = (str("query") || "").toLowerCase();
        const defs = Object.entries(NODE_TYPES)
          .filter(([, d]) => (!cat || d.category === cat) && (!q || d.name.toLowerCase().includes(q) || d.description.toLowerCase().includes(q)))
          .slice(0, 40)
          .map(([t, d]) => ({
            type: t, name: d.name, cat: d.category, desc: d.description.slice(0, 90),
            inputs: d.inputs.map((p) => `${p.name}:${p.type}${p.multi ? "*" : ""}`),
            outputs: d.outputs.map((p) => `${p.name}:${p.type}`),
            fields: d.fields.slice(0, 14).map((fd) => fd.name),
          }));
        return JSON.stringify({ types: defs });
      }
      case "list_nodes":
        return buildCanvasState();
      case "semantic_search": {
        const q = str("query"); if (!q) return "error: query required";
        const r = await fetch("/api/semantic-search", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: q, brandId: workflowMeta.brandId || undefined, modality: str("kind"), limit: 12 }) });
        const j = (await r.json()) as { results?: { assetId: string | null; url: string; modality: string; category: string | null }[]; error?: string };
        if (!r.ok) return `error: ${j.error || "search failed"}`;
        const res = (j.results || []).filter((x) => x.url).slice(0, 12).map((x) => ({ url: x.url, kind: x.modality, cat: x.category || undefined }));
        return JSON.stringify({ results: res });
      }
      case "add_node": {
        const type = str("type");
        if (!type || !NODE_TYPES[type]) return `error: unknown type "${type}" (use list_node_types)`;
        const g = graphRef.current;
        let px = num("x"); let py = num("y");
        if (px == null || py == null) {
          // auto-place on a grid, skipping cells that overlap existing nodes
          const COL = 360, ROW = 230, NW = 300, NH = 190;
          const startX = g.nodes.length ? Math.max(...g.nodes.map((n) => n.position.x)) + COL : 140;
          const overlaps = (x: number, y: number) => g.nodes.some((n) => Math.abs(n.position.x - x) < NW && Math.abs(n.position.y - y) < NH);
          let placed = false;
          for (let col = 0; col < 6 && !placed; col++) {
            for (let row = 0; row < 6 && !placed; row++) {
              const x = startX + col * COL, y = 120 + row * ROW;
              if (!overlaps(x, y)) { px = x; py = y; placed = true; }
            }
          }
          if (!placed) { px = startX + 6 * COL; py = 120; }
        }
        const node = makeNode(type, { x: px as number, y: py as number });
        const patch = (args.config && typeof args.config === "object") ? (args.config as Record<string, unknown>) : null;
        if (patch) node.config = { ...node.config, ...patch };
        setGraph((gr) => ({ ...gr, nodes: [...gr.nodes, node] }));
        await new Promise((r) => setTimeout(r, 30));
        return `added node ${node.id} (${NODE_TYPES[type].name}) at (${Math.round(px as number)}, ${Math.round(py as number)})`;
      }
      case "group_nodes": {
        const ids = Array.isArray(args.node_ids) ? (args.node_ids as unknown[]).filter((x): x is string => typeof x === "string") : [];
        const valid = ids.filter((id) => graphRef.current.nodes.some((n) => n.id === id));
        if (valid.length < 2) return "error: need at least 2 existing node_ids to group";
        const label = str("label");
        const color = str("color");
        const group = { id: `grp-${Date.now().toString(36)}`, nodeIds: valid, ...(label ? { label } : {}), ...(color ? { color } : {}) };
        setGraph((gr) => ({ ...gr, groups: [...(gr.groups ?? []), group] }));
        return `grouped ${valid.length} nodes${label ? ` as "${label}"` : ""}`;
      }
      case "arrange": {
        // Tidy the whole graph into columns by dependency depth (sources left).
        const g = graphRef.current;
        const depth = new Map<string, number>();
        const inc = new Map<string, string[]>();
        for (const e of g.edges) inc.set(e.to.nodeId, [...(inc.get(e.to.nodeId) || []), e.from.nodeId]);
        const calc = (id: string, seen: Set<string>): number => {
          if (depth.has(id)) return depth.get(id)!;
          if (seen.has(id)) return 0;
          seen.add(id);
          const parents = inc.get(id) || [];
          const d = parents.length ? Math.max(...parents.map((p) => calc(p, seen))) + 1 : 0;
          depth.set(id, d); return d;
        };
        for (const n of g.nodes) calc(n.id, new Set());
        const cols = new Map<number, string[]>();
        for (const n of g.nodes) { const d = depth.get(n.id) || 0; cols.set(d, [...(cols.get(d) || []), n.id]); }
        const COL = 360, ROW = 230;
        const pos = new Map<string, { x: number; y: number }>();
        for (const [d, list] of cols) list.forEach((id, i) => pos.set(id, { x: 140 + d * COL, y: 120 + i * ROW }));
        setGraph((gr) => ({ ...gr, nodes: gr.nodes.map((n) => ({ ...n, position: pos.get(n.id) || n.position })) }));
        return `arranged ${g.nodes.length} nodes into ${cols.size} columns`;
      }
      case "set_config": {
        const n = nodeOf(); if (!n) return "error: node not found";
        const patch = (args.patch && typeof args.patch === "object") ? (args.patch as Record<string, unknown>) : null;
        if (!patch || !Object.keys(patch).length) return "error: patch required";
        setGraph((gr) => ({ ...gr, nodes: gr.nodes.map((x) => (x.id === n.id ? { ...x, config: { ...x.config, ...patch } } : x)) }));
        return `updated config of ${n.id}: ${Object.keys(patch).join(", ")}`;
      }
      case "connect": {
        const fn = str("from_node"), fp = str("from_port"), tn = str("to_node"), tp = str("to_port");
        const g = graphRef.current;
        const from = g.nodes.find((n) => n.id === fn), to = g.nodes.find((n) => n.id === tn);
        if (!from || !to || !fp || !tp) return "error: from_node/from_port/to_node/to_port required";
        const ft = NODE_TYPES[from.type]?.outputs.find((p) => p.name === fp)?.type;
        const tt = NODE_TYPES[to.type]?.inputs.find((p) => p.name === tp)?.type;
        if (!ft) return `error: ${from.type} has no output "${fp}"`;
        if (!tt) return `error: ${to.type} has no input "${tp}"`;
        if (!portsCompatible(ft, tt)) return `error: can't connect ${ft} -> ${tt}`;
        setGraph((gr) => ({ ...gr, edges: addEdgeRespectingMulti(gr.edges, makeEdge(from.id, fp, to.id, tp), gr) }));
        return `connected ${from.id}.${fp} -> ${to.id}.${tp}`;
      }
      case "disconnect": {
        const tn = str("to_node"), tp = str("to_port"), fn = str("from_node");
        if (!tn) return "error: to_node required";
        let removed = 0;
        setGraph((gr) => {
          const keep = gr.edges.filter((e) => {
            const hit = e.to.nodeId === tn && (!tp || e.to.port === tp) && (!fn || e.from.nodeId === fn);
            if (hit) removed++;
            return !hit;
          });
          return { ...gr, edges: keep };
        });
        await new Promise((r) => setTimeout(r, 20));
        return `removed ${removed} edge(s)`;
      }
      case "delete_nodes": {
        const ids = Array.isArray(args.node_ids) ? (args.node_ids as unknown[]).filter((x): x is string => typeof x === "string") : [];
        if (!ids.length) return "error: node_ids required";
        const set = new Set(ids);
        setGraph((gr) => ({ ...gr, nodes: gr.nodes.filter((n) => !set.has(n.id)), edges: gr.edges.filter((e) => !set.has(e.from.nodeId) && !set.has(e.to.nodeId)) }));
        return `deleted ${ids.length} node(s)`;
      }
      case "run": {
        const id = str("node_id");
        if (id && !nodeOf()) return "error: node not found";
        void startRun(id);
        return id ? `run started for ${id} (async - check with read_node later)` : "full run started (async)";
      }
      case "read_node": {
        const n = nodeOf(); if (!n) return "error: node not found";
        const outs: Record<string, string> = {};
        if (n.outputs) for (const [k, v] of Object.entries(n.outputs)) outs[k] = String(v).slice(0, 140);
        return JSON.stringify({ id: n.id, status: n.status || "idle", error: n.error?.slice(0, 200), outputs: outs, results: n.results?.slice(0, 6).map((r) => r.value.slice(0, 120)) });
      }
      case "send_to_editor": {
        const g = graphRef.current;
        const comp = str("node_id") ? nodeOf() : g.nodes.find((n) => n.type === "composer");
        if (!comp || comp.type !== "composer") return "error: no composer (Editor) node on the canvas";
        const tracks = buildComposerTracks(comp.id);
        if (!tracks.length) return "error: nothing is wired into the Editor node";
        try { localStorage.setItem(`flowlab.editor.import.v1:${workflowId}`, JSON.stringify({ tracks })); } catch { return "error: could not store the handoff"; }
        return `sent ${tracks.length} track(s) to the editor - open it via the Editor node to see them in Media`;
      }
      default: return `error: unknown tool "${a.tool}"`;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buildCanvasState, buildComposerTracks, workflowId, workflowMeta.brandId]);

  const runCanvasAgent = useCallback(async (userText: string) => {
    if (agentBusy) return;
    setAgentBusy(true);
    const attached = agentFiles;
    const imgCount = attached.filter((a) => a.kind === "image").length;
    const attachNote = attached.length
      ? `\n\n[The user attached ${attached.length} file(s)${imgCount ? ` - the ${imgCount} image(s) are shown to you directly, describe/use what you see` : ""}. Use their URLs directly when building (add_node uploadVideo/uploadImage/uploadAudio with config.url, then wire in):\n${attached.map((a) => `- ${a.kind}: ${a.url} (${a.name})`).join("\n")}]`
      : "";
    const shownText = attached.length ? `${userText}${userText ? "\n" : ""}📎 ${attached.map((a) => a.name).join(", ")}` : userText;
    const history: CAgentMsg[] = [...agentMsgs, { role: "user", content: shownText }];
    setAgentMsgs(history);
    setAgentFiles([]);
    try {
      const imageUrls = attached.filter((a) => a.kind === "image").map((a) => a.url);
      let msgs: CAgentMsg[] = [...agentMsgs, { role: "user", content: `${userText}${attachNote}` }];
      for (let round = 0; round < 4; round++) {
        const r = await fetch("/api/canvas-agent", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: msgs.map(({ role, content }) => ({ role, content })), state: buildCanvasState(), model: agentModel, images: round === 0 ? imageUrls : [] }),
        });
        const j = (await r.json()) as { reply?: string; actions?: CAgentAction[]; continue?: boolean; error?: string };
        if (!r.ok) throw new Error(j.error || "agent request failed");
        const actions = j.actions || [];
        const chips: CAgentChip[] = [];
        for (const act of actions) {
          try { const res = await executeCanvasAction(act); chips.push({ tool: act.tool, ok: !res.startsWith("error"), result: res }); }
          catch (e) { chips.push({ tool: act.tool, ok: false, result: e instanceof Error ? e.message : "failed" }); }
        }
        const hadErrors = chips.some((c) => !c.ok);
        // Keep going if the model asked to, OR if something failed - the agent
        // sees the errors next round and repairs its own work.
        const willContinue = actions.length > 0 && (j.continue || hadErrors) && round < 3;
        const asst: CAgentMsg = { role: "assistant", content: JSON.stringify({ reply: j.reply, actions }), chips: willContinue ? undefined : chips };
        msgs = [...msgs, { ...asst, chips }];
        setAgentMsgs((prev) => [...prev, { ...asst, content: j.reply || "" }]);
        if (!willContinue) break;
        await new Promise((res) => setTimeout(res, 120));
        msgs = [...msgs, { role: "tool", content: chips.map((c) => `${c.tool}: ${c.result}${!c.ok ? " - FIX THIS: rewire/adjust and retry now" : ""}`).join("\n") }];
      }
    } catch (e) {
      setAgentMsgs((prev) => [...prev, { role: "assistant", content: `Agent error: ${e instanceof Error ? e.message : "unknown"}` }]);
    } finally { setAgentBusy(false); }
  }, [agentBusy, agentMsgs, agentFiles, buildCanvasState, executeCanvasAction, agentModel]);

  async function startRun(scopeArg?: string | string[]) {
    const scopeNodeId = Array.isArray(scopeArg)
      ? (scopeArg.length === 1 ? scopeArg[0] : scopeArg.length ? [...scopeArg].sort() : undefined)
      : scopeArg;
    const targetSet = scopeNodeId
      ? new Set(Array.isArray(scopeNodeId) ? scopeNodeId : [scopeNodeId])
      : null;
    const scopeKey = scopeNodeId ? (Array.isArray(scopeNodeId) ? scopeNodeId.join("+") : scopeNodeId) : "__all__";
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
        targetSet && !targetSet.has(n.id)
          ? n
          : { ...n, status: "running", outputs: undefined, error: undefined, results: undefined },
      ),
    }));

    try {
      const cleaned: Graph = {
        nodes: graph.nodes.map((n) => ({ id: n.id, type: n.type, position: n.position, config: n.config, outputs: n.outputs, results: n.results, outputsSig: n.outputsSig })),
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

      const scopeName = Array.isArray(scopeNodeId)
        ? `${scopeNodeId.length} nodes`
        : scopeNodeId
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
          targetSet && !targetSet.has(n.id) ? n : { ...n, status: "error", error: err instanceof Error ? err.message : "Run failed" },
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
    // Immediately clear the spinners: nodes of this run that never got a
    // final step status used to spin until a manual page reload.
    const stopped = runs.find((r) => r.id === runId);
    const scope = stopped?.scopeNodeId;
    const inScope = (id: string) =>
      !scope || (Array.isArray(scope) ? scope.includes(id) : scope === id);
    setGraph((g) => ({
      ...g,
      nodes: g.nodes.map((n) =>
        (n.status === "running" || n.status === "pending") && inScope(n.id)
          ? { ...n, status: "idle" }
          : n,
      ),
    }));
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
        const runTerminal =
          data.status === "done" || data.status === "error" || data.status === "cancelled";
        setGraph((g) => ({
          ...g,
          nodes: g.nodes.map((n) => {
            // A retry can leave more than one step record for the same node
            // (one killed/stuck, one that actually completed). Prefer the
            // successful one so the canvas shows the real result, not a stale
            // "running" duplicate.
            const stepsForNode = data.steps.filter((s) => s.nodeId === n.id);
            const step =
              stepsForNode.find((s) => s.status === "done") ??
              stepsForNode.find(
                (s) => (s.assets?.length || (s.outputData && Object.keys(s.outputData).length)),
              ) ??
              stepsForNode[stepsForNode.length - 1];
            if (!step) {
              // The whole run has ended but this node is still spinning locally
              // (its worker was killed before writing any step) — stop the
              // spinner so the canvas doesn't hang forever on "Generating…".
              if (runTerminal && n.status === "running") return { ...n, status: "done" as const };
              return n;
            }
            let st: "pending" | "running" | "done" | "error" = step.status;
            // If the run has finished but a step is still running/pending (its
            // worker was killed mid-flight and never wrote a terminal status),
            // never leave the canvas spinning: mark it done if it produced
            // output, otherwise error.
            if (runTerminal && (st === "running" || st === "pending")) {
              st =
                (step.assets?.length || (step.outputData && Object.keys(step.outputData).length))
                  ? "done"
                  : "error";
            }
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
              status: st,
              outputs: step.outputData ?? n.outputs,
              error: st === "error" ? (step.errorMessage ?? "Step did not finish") : (step.errorMessage ?? undefined),
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
          // Any node still spinning without a final step (cancelled runs,
          // steps that never started) goes back to idle - no zombie loaders.
          const finalStepStatus = new Map(data.steps.map((s) => [s.nodeId, s.status] as const));
          setGraph((g) => ({
            ...g,
            nodes: g.nodes.map((n) => {
              if (n.status !== "running" && n.status !== "pending") return n;
              const st = finalStepStatus.get(n.id);
              if (st === "done" || st === "error") return n; // step mapping handles it
              return { ...n, status: "idle" };
            }),
          }));
        }
      } catch (err) {
        console.error("Poll error:", err);
      }
    }, 4000);
    activeRunPoll.current.set(runId, interval);
  }

  // ─────────────────────────────── Render
  const expandedNode = expandedNodeId ? graph.nodes.find((n) => n.id === expandedNodeId) : null;

  // Re-point the handler trampoline at this render's fresh closures (see the
  // declaration above for why). Assigned during render on purpose: pointer/
  // keyboard events always happen after the render that scheduled them.
  nodeHandlersRef.current = {
    startNodeDrag,
    startEdge,
    endEdgeOnInput,
    toggleSelect,
    deleteNode,
    updateNodeConfig,
    startRun,
    askAgent: (nodeId: string) => {
      setAgentOpen(true); setAgentMin(false);
      void runCanvasAgent(`Read the analysis output of node ${nodeId} with read_node, then propose (in my language) a concrete FlowLab structure to reproduce it: which nodes, what prompts/config, how sections wire into the Editor. Present the plan and ask before building.`);
    },
    stopForNode: (nodeId: string) => {
      // Find any active run that touches this node and cancel it
      const targetRun = runs.find(
        (r) => r.status === "running" && (!r.scopeNodeId || (Array.isArray(r.scopeNodeId) ? r.scopeNodeId.includes(nodeId) : r.scopeNodeId === nodeId)),
      );
      if (targetRun) void stopRun(targetRun.id);
    },
    expandNode: (nodeId: string) => setExpandedNodeId(nodeId),
    removeResult: (nodeId: string, idx: number) => {
      setGraph((g) => ({
        ...g,
        nodes: g.nodes.map((n) => {
          if (n.id !== nodeId || !n.results || n.results.length <= 1) return n;
          const results = n.results.filter((_, i) => i !== idx);
          const selRaw = typeof n.config?._selectedResultIdx === "number" ? (n.config._selectedResultIdx as number) : 0;
          const sel = Math.max(0, Math.min(results.length - 1, selRaw > idx ? selRaw - 1 : selRaw));
          return { ...n, results: results.length > 1 ? results : results, config: { ...n.config, _selectedResultIdx: sel } };
        }),
      }));
    },
    restoreHistory: (nodeId: string, url: string) => {
      // Bring a previous generation back as the CURRENT result: prepend it to
      // results (deduped) and select it, so downstream nodes pick it up.
      setGraph((g) => ({
        ...g,
        nodes: g.nodes.map((n) => {
          if (n.id !== nodeId) return n;
          const cur = n.results && n.results.length > 0
            ? n.results
            : Object.entries(n.outputs ?? {})
                .filter(([k, v]) => typeof v === "string" && (v as string).startsWith("http") && k !== "track_url" && !k.startsWith("_"))
                .map(([, v]) => ({ value: v as string }));
          const results = [{ value: url }, ...cur.filter((r) => r.value !== url)];
          const history = (n.history ?? []).filter((h) => h.value !== url);
          return { ...n, results, history: history.length ? history : undefined, config: { ...n.config, _selectedResultIdx: 0 } };
        }),
      }));
    },
    stashTracks: (nodeId: string) => {
      try { localStorage.setItem(`flowlab.editor.import.v1:${workflowId}`, JSON.stringify({ tracks: buildComposerTracks(nodeId) ?? [] })); } catch { /* */ }
    },
  };

  return (
    <div className="flex flex-col h-full bg-bg">
      <CanvasToolbar
        workflowName={workflowName}
        saveState={saveState}
        isRunning={isRunning}
        runCount={runs.length}
        onRunAll={() => startRun()}
        onStopAll={() => stopAllRuns()}
        onBuildAI={() => { setAgentOpen(true); setAgentMin(false); }}
        brandSlug={workflowMeta.brandSlug}
        projectId={workflowMeta.projectId}
        workflowId={workflowId}
      />


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
            if (e.dataTransfer.types.includes("application/x-flowlab-asset") || e.dataTransfer.types.includes("Files")) {
              e.preventDefault();
              e.dataTransfer.dropEffect = "copy";
            }
          }}
          onDrop={(e) => {
            const raw = e.dataTransfer.getData("application/x-flowlab-asset");
            if (raw) {
              e.preventDefault();
              try {
                const { cdnUrl, kind } = JSON.parse(raw) as { cdnUrl: string; kind: string };
                const pt = screenToCanvas(e.clientX, e.clientY);
                addAssetNode(cdnUrl, kind, pt.x, pt.y);
              } catch {
                /* ignore malformed drop */
              }
              return;
            }
            const files = e.dataTransfer.files;
            if (files && files.length) {
              e.preventDefault();
              const pt = screenToCanvas(e.clientX, e.clientY);
              void importFiles(Array.from(files), pt);
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

          {/* Active runs — prominent strip at the top with per-run + global stop */}
          <ActiveRunsBar runs={runs} onStop={stopRun} onStopAll={stopAllRuns} />

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
              selectedIds={selectedIds}
              edgeStyle={edgeStyle}
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
              // Resolve the connected source_video URL (for the Screen Replace
              // track editor). resolvedInputs above deliberately drops URLs, so
              // we resolve the media input separately here.
              let screenSourceUrl = "";
              for (const edge of graph.edges) {
                if (edge.to.nodeId !== node.id || edge.to.port !== "source_video") continue;
                const src = graph.nodes.find((n) => n.id === edge.from.nodeId);
                const v = src?.outputs ? (src.outputs as Record<string, unknown>)[edge.from.port] : undefined;
                if (typeof v === "string" && v) { screenSourceUrl = v; break; }
              }
              // Composer: resolve connected upstream outputs into an ordered track list
              let composerTracks: { kind: string; value: string; label: string }[] | undefined;
              if (node.type === "composer") composerTracks = buildComposerTracks(node.id);
              // videoGen: resolve connected reference inputs (with thumbnail
              // URLs) so the node can show numbered chips and insert
              // @Image1 / [Video1] tokens into the prompt by click. Order
              // follows edge order to match the runner's numbering.
              let videoRefs: { port: string; kind: "image" | "video"; url: string }[] | undefined;
              if (node.type === "videoGen") {
                const REF_PORTS = ["references", "reference_videos", "source_video", "start_frame", "end_frame"];
                const out: { port: string; kind: "image" | "video"; url: string }[] = [];
                const pushUrl = (port: string, v: unknown) => {
                  if (typeof v !== "string" || !v.startsWith("http")) return;
                  const isVid = port === "source_video" || port === "reference_videos" || /\.(mp4|webm|mov|m4v|avi|mkv)(\?|#|$)/i.test(v);
                  out.push({ port, kind: isVid ? "video" : "image", url: v });
                };
                for (const e of graph.edges.filter((x) => x.to.nodeId === node.id && REF_PORTS.includes(x.to.port))) {
                  const from = graph.nodes.find((n) => n.id === e.from.nodeId);
                  if (!from) continue;
                  if (from.type === "brandAssets") {
                    const sel = from.config?.selected;
                    if (Array.isArray(sel) && sel.length) sel.forEach((u) => pushUrl(e.to.port, u));
                    else if (from.results) from.results.forEach((r) => pushUrl(e.to.port, r.value));
                    continue;
                  }
                  let v: unknown = from.outputs?.[e.from.port];
                  if (from.results && from.results.length > 1 && typeof from.config?._selectedResultIdx === "number") {
                    const picked = from.results[from.config._selectedResultIdx as number];
                    if (picked?.value) v = picked.value;
                  }
                  if (v == null) {
                    const cfg = from.config ?? {};
                    if (from.type === "uploadVideo" || from.type === "uploadAudio") v = (cfg.cdnUrl as string) || (cfg.url as string);
                    else if (from.type === "uploadImage") v = cfg.cdnUrl as string;
                  }
                  pushUrl(e.to.port, v);
                }
                videoRefs = out;
              }
              return (
              <CanvasNode
                key={node.id}
                node={node}
                edges={graph.edges}
                resolvedInputs={resolvedInputs}
                sourceVideoUrl={screenSourceUrl}
                cachedTrackUrl={(node.outputs?.track_url as string) || undefined}
                isSelected={selectedIds.has(node.id)}
                isRunning={isRunning}
                onPointerDown={(e) => nodeHandlersRef.current.startNodeDrag(node.id, e)}
                onOutputPortDown={(portId, e) => nodeHandlersRef.current.startEdge(node.id, portId, e)}
                onInputPortUp={(portId, e) => nodeHandlersRef.current.endEdgeOnInput(node.id, portId, e)}
                onSelect={(additive) => nodeHandlersRef.current.toggleSelect(node.id, additive)}
                onDelete={() => nodeHandlersRef.current.deleteNode(node.id)}
                onConfigChange={(k, v) => nodeHandlersRef.current.updateNodeConfig(node.id, k, v)}
                onRemoveResult={(i) => nodeHandlersRef.current.removeResult(node.id, i)}
                onRestoreHistory={(url) => nodeHandlersRef.current.restoreHistory(node.id, url)}
                onRun={() => nodeHandlersRef.current.startRun(node.id)}
                onAskAgent={() => nodeHandlersRef.current.askAgent(node.id)}
                onStop={() => nodeHandlersRef.current.stopForNode(node.id)}
                onExpand={() => nodeHandlersRef.current.expandNode(node.id)}
                onUploadFile={uploadFile}
                workflowMeta={{ ...workflowMeta, workflowId }}
                composerTracks={composerTracks}
                videoRefs={videoRefs}
                editorHref={node.type === "composer" ? `/editor?wf=${workflowId}&proj=${workflowMeta.projectId}` : undefined}
                onStashTracks={node.type === "composer" ? () => nodeHandlersRef.current.stashTracks(node.id) : undefined}
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
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1 bg-bg-card hairline rounded-full px-2 py-1 elev-2">
            <button
              onClick={() => setZoom((z) => Math.max(0.05, +(z / 1.2).toFixed(3)))}
              className="w-7 h-7 rounded-full flex items-center justify-center hover:bg-bg-hover text-fg-muted group relative hover:text-fg"
              title="Zoom out"
            >
              <Minus size={12} />
              <span className="pointer-events-none absolute -top-8 left-1/2 -translate-x-1/2 px-1.5 py-0.5 rounded bg-bg-card border border-border text-[9px] text-fg whitespace-nowrap opacity-0 group-hover:opacity-100 transition shadow-node">Zoom out</span>
            </button>
            <span className="text-[10px] text-fg-muted px-1 tabular-nums">{Math.round(zoom * 100)}%</span>
            <button
              onClick={() => setZoom((z) => Math.min(2.5, +(z * 1.2).toFixed(3)))}
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
            <button
              onClick={toggleEdgeStyle}
              className={`w-7 h-7 rounded-full flex items-center justify-center hover:bg-bg-hover group relative ${edgeStyle === "ortho" ? "text-brand" : "text-fg-muted hover:text-fg"}`}
              title="Toggle wire style: curves / right angles"
            >
              <Network size={12} />
              <span className="pointer-events-none absolute -top-8 left-1/2 -translate-x-1/2 px-1.5 py-0.5 rounded bg-bg-card border border-border text-[9px] text-fg whitespace-nowrap opacity-0 group-hover:opacity-100 transition shadow-node">{edgeStyle === "ortho" ? "Wires: right angles" : "Wires: curves"}</span>
            </button>
            <button
              onClick={() => setTrashOpen((v) => !v)}
              className={`w-7 h-7 rounded-full flex items-center justify-center hover:bg-bg-hover group relative ${trash.length ? "text-fg-muted hover:text-fg" : "text-fg-subtle/50"}`}
              title="Deleted nodes (restore with their settings)"
            >
              <Trash2 size={12} />
              {trash.length > 0 && <span className="absolute -top-1 -right-1 min-w-[14px] h-3.5 px-0.5 rounded-full bg-brand text-black text-[8px] leading-[14px] text-center tabular-nums">{trash.length}</span>}
              <span className="pointer-events-none absolute -top-8 left-1/2 -translate-x-1/2 px-1.5 py-0.5 rounded bg-bg-card border border-border text-[9px] text-fg whitespace-nowrap opacity-0 group-hover:opacity-100 transition shadow-node">Deleted nodes</span>
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

          {trashOpen && (
            <div data-overlay className="absolute bottom-14 left-1/2 -translate-x-1/2 z-40 w-80 max-h-72 overflow-y-auto rounded-lg border border-border bg-bg-card shadow-node p-2"
              onPointerDown={(e) => e.stopPropagation()}>
              <div className="flex items-center justify-between px-1 pb-1.5">
                <span className="text-[10px] uppercase tracking-wider text-fg-subtle">Deleted nodes</span>
                <button onClick={() => setTrashOpen(false)} className="text-fg-subtle hover:text-fg"><XIcon size={12} /></button>
              </div>
              {trash.length === 0 ? (
                <div className="text-fg-subtle text-[11px] px-1 py-3 text-center">Empty - deleted nodes appear here with their settings.</div>
              ) : (
                <div className="space-y-1">
                  {trash.map((t) => {
                    const def = NODE_TYPES[t.node.type];
                    const snippet = String(t.node.config?.[def?.primaryField ?? "instructions"] ?? "").slice(0, 60);
                    return (
                      <div key={t.at} className="flex items-center gap-2 px-1.5 py-1 rounded hover:bg-bg-hover">
                        <div className="flex-1 min-w-0">
                          <div className="text-[11px] text-fg truncate">{def?.name ?? t.node.type}</div>
                          <div className="text-[9px] text-fg-subtle truncate">{snippet || new Date(t.at).toLocaleTimeString()}</div>
                        </div>
                        <button onClick={() => restoreFromTrash(t.at)}
                          className="shrink-0 text-[10px] text-brand hover:underline underline-offset-2">Restore</button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {showAssets && (
            <AssetDrawer
              onClose={() => setShowAssets(false)}
              brandId={workflowMeta.brandId}
              projectId={workflowMeta.projectId}
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

          <RunsPanel runs={runs} projectSpentUsd={projectSpentUsd} workflowEstimateUsd={workflowEstimateUsd} selectionEstimateUsd={selectionEstimateUsd} selectionCount={selectedIds.size} />
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
            {
              label: multi && selectedIds.has(nodeId) ? `Run selected (${selectedIds.size})` : "Run",
              icon: <Play size={13} />,
              onClick: () => startRun(multi && selectedIds.has(nodeId) ? [...selectedIds] : nodeId),
            },
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
            label: "Node color...",
            icon: <Pencil size={13} />,
            onClick: () => {
              // Native color input (eyedropper included in Chromium). Stored
              // as config._color - a UI-only key, so it never invalidates the
              // node's result cache.
              const cur = String(graph.nodes.find((x) => x.id === nodeId)?.config?._color ?? "#10b981");
              const inp = document.createElement("input");
              inp.type = "color";
              inp.value = /^#[0-9a-fA-F]{6}$/.test(cur) ? cur : "#10b981";
              inp.style.position = "fixed"; inp.style.opacity = "0"; inp.style.pointerEvents = "none";
              // Anchor the native dialog to the menu instead of the window's
              // top-left corner (browsers open it next to the input element).
              inp.style.left = `${actionMenu.x}px`; inp.style.top = `${actionMenu.y}px`;
              inp.oninput = () => updateNodeConfig(nodeId, "_color", inp.value);
              inp.onchange = () => inp.remove();
              document.body.appendChild(inp);
              inp.click();
            },
          });
          if (graph.nodes.find((x) => x.id === nodeId)?.config?._color) {
            items.push({
              label: "Clear color",
              icon: <XIcon size={13} />,
              onClick: () => updateNodeConfig(nodeId, "_color", ""),
            });
          }
          items.push({
            label: "Reset node",
            icon: <RefreshCw size={13} />,
            onClick: () => {
              // Back to a factory-fresh node: default config, no outputs /
              // results / history / status. Position and wiring stay.
              const src = graph.nodes.find((x) => x.id === nodeId);
              const def = src ? NODE_TYPES[src.type] : undefined;
              if (!src || !def) return;
              setGraph((g) => ({
                ...g,
                nodes: g.nodes.map((n) => (n.id === nodeId
                  ? { ...n, config: JSON.parse(JSON.stringify(def.defaults ?? {})), outputs: undefined, results: undefined, outputsSig: undefined, history: undefined, status: "idle", error: undefined }
                  : n)),
              }));
            },
            separator: true,
          });
          items.push({
            label: multi ? "Delete selected" : "Delete",
            icon: <Trash2 size={13} />,
            onClick: () => (multi ? deleteSelected() : deleteNode(nodeId)),
            danger: true,
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
            { label: "Align as row", icon: <Network size={13} />, onClick: () => alignGroup(groupId, "row") },
            { label: "Align as column", icon: <Network size={13} />, onClick: () => alignGroup(groupId, "column") },
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
          sourceVideoUrl={(() => {
            for (const edge of graph.edges) {
              if (edge.to.nodeId !== expandedNode.id || edge.to.port !== "source_video") continue;
              const src = graph.nodes.find((n) => n.id === edge.from.nodeId);
              const v = src?.outputs ? (src.outputs as Record<string, unknown>)[edge.from.port] : undefined;
              if (typeof v === "string" && v) return v;
            }
            return "";
          })()}
          cachedTrackUrl={(expandedNode.outputs?.track_url as string) || undefined}
          incomingPrompt={(() => {
            const d = NODE_TYPES[expandedNode.type];
            const parts: string[] = [];
            for (const edge of graph.edges) {
              if (edge.to.nodeId !== expandedNode.id) continue;
              const pd = d?.inputs?.find((p) => p.name === edge.to.port);
              if (!pd || pd.type !== "text") continue;
              const src = graph.nodes.find((n) => n.id === edge.from.nodeId);
              const v = src?.outputs ? (src.outputs as Record<string, unknown>)[edge.from.port] : undefined;
              if (typeof v === "string" && v.trim()) parts.push(v);
            }
            return parts.join("\n\n");
          })()}
          onClose={() => setExpandedNodeId(null)}
          onConfigChange={(k, v) => updateNodeConfig(expandedNode.id, k, v)}
          onRun={() => {
            startRun(expandedNode.id);
            setExpandedNodeId(null);
          }}
        />
      )}

      {/* Canvas AI agent - floating pill sits ABOVE the minimap (bottom-right)
          so the two never overlap. Shown only when the panel is closed or
          minimized. */}
      {(!agentOpen || agentMin) && (
        <button onClick={() => { setAgentOpen(true); setAgentMin(false); }}
          className="fixed right-5 z-[90] h-9 pl-3 pr-3.5 rounded-full bg-bg-card border border-brand/50 shadow-xl inline-flex items-center gap-2 text-[12px] text-fg hover:border-brand"
          style={{ bottom: graph.nodes.length > 0 ? 168 : 20 }}>
          <Sparkles size={13} className="text-brand" /> AI Agent
          {agentBusy && <span className="w-3 h-3 rounded-full border border-border border-t-brand animate-spin" />}
        </button>
      )}
      {agentOpen && !agentMin && (
        <div className="fixed z-[90] w-[360px] max-w-[calc(100vw-2rem)] rounded-2xl border border-border bg-bg-card shadow-2xl flex flex-col text-[12px] overflow-hidden"
          style={agentPos ? { left: agentPos.x, top: agentPos.y, maxHeight: "min(560px, 72vh)" } : { bottom: 20, right: 20, maxHeight: "min(560px, 72vh)" }}>
          <div onPointerDown={onAgentDragDown} onPointerMove={onAgentDragMove} onPointerUp={onAgentDragUp}
            className="flex items-center justify-between pl-3.5 pr-2 py-2.5 border-b border-border shrink-0 cursor-grab active:cursor-grabbing select-none touch-none" title="Drag to move">
            <span className="inline-flex items-center gap-1.5 text-fg font-medium"><Sparkles size={13} className="text-brand" /> AI Agent</span>
            <select value={agentModel} onChange={(e) => setAgentModel(e.target.value)} title="Model that plans the actions"
              className="max-w-[140px] bg-bg border border-border rounded-md px-1.5 py-1 text-[10px] text-fg-muted outline-none focus:border-brand">
              {LLM_MODELS.map((m) => <option key={m.id} value={m.id}>{m.label.replace(" (text only)", "")}</option>)}
            </select>
            <div className="flex items-center gap-0.5">
              {agentMsgs.length > 0 && <button onClick={() => setAgentMsgs([])} title="Clear the conversation" className="h-7 px-2 grid place-items-center rounded-md text-fg-subtle hover:text-fg hover:bg-bg-hover text-[11px]">Clear</button>}
              <button onClick={() => setAgentMin(true)} title="Minimize" className="w-7 h-7 grid place-items-center rounded-md text-fg-subtle hover:text-fg hover:bg-bg-hover"><Minus size={14} /></button>
              <button onClick={() => setAgentOpen(false)} title="Close" className="w-7 h-7 grid place-items-center rounded-md text-fg-subtle hover:text-fg hover:bg-bg-hover"><XIcon size={14} /></button>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto px-3 py-2 space-y-2 min-h-[120px]">
            {agentMsgs.length === 0 && (
              <div className="text-fg-subtle text-[11px] leading-relaxed py-2">
                I can build and run this workflow: create and wire nodes, write generator prompts, group clips into Hook/Body/Packshot, run generations and send tracks to the editor. Try:
                <div className="mt-1.5 space-y-1">
                  {["Build a pipeline: 2 hooks + a body + a packshot into the Editor node", "Write a punchy prompt for the video generator and run it", "What is on this canvas? Anything failed?"].map((ex) => (
                    <button key={ex} onClick={() => { if (!agentBusy) void runCanvasAgent(ex); }} className="block w-full text-left px-2 py-1 rounded border border-border/60 text-fg-muted hover:border-brand hover:text-fg">{ex}</button>
                  ))}
                </div>
              </div>
            )}
            {agentMsgs.filter((m) => m.role !== "tool").map((m, i) => (
              <div key={i} className={m.role === "user" ? "flex justify-end" : "flex justify-start"}>
                <div className={`max-w-[92%] rounded-lg px-2.5 py-1.5 leading-relaxed ${m.role === "user" ? "bg-brand/15 text-fg" : "bg-bg text-fg"}`}>
                  <div className="whitespace-pre-wrap break-words">{m.content}</div>
                  {m.chips && m.chips.some((ch) => !ch.ok) && (
                    <div className="mt-1 text-[10px] text-red-400/90">{m.chips.filter((ch) => !ch.ok).map((ch) => `${ch.tool}: ${ch.result}`).join("; ")}</div>
                  )}
                </div>
              </div>
            ))}
            {agentBusy && <div className="flex items-center gap-2 text-fg-subtle"><span className="w-3 h-3 rounded-full border border-border border-t-brand animate-spin" /> working{"\u2026"}</div>}
            <div ref={agentEndRef} />
          </div>
          <div className="px-3 pb-3 pt-2 shrink-0">
            {(agentFiles.length > 0 || agentUploading) && (
              <div className="flex flex-wrap gap-1 mb-1.5">
                {agentFiles.map((f, i) => (
                  <span key={i} className="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-full bg-bg border border-border text-[10px] text-fg-muted max-w-[160px]">
                    <span className="truncate">{f.kind === "image" ? "🖼" : f.kind === "audio" ? "🎵" : "🎬"} {f.name}</span>
                    <button onClick={() => setAgentFiles((prev) => prev.filter((_, k) => k !== i))} className="text-fg-subtle hover:text-fg"><XIcon size={11} /></button>
                  </span>
                ))}
                {agentUploading && <span className="inline-flex items-center gap-1.5 px-2 py-0.5 text-[10px] text-fg-subtle"><span className="w-3 h-3 rounded-full border border-border border-t-brand animate-spin" /> uploading</span>}
              </div>
            )}
            <input ref={agentFileInputRef} type="file" accept="video/*,image/*,audio/*" multiple className="hidden" onChange={(e) => { void onAgentFiles(e.target.files); e.currentTarget.value = ""; }} />
            <div className="flex items-center gap-1.5 rounded-[20px] bg-bg border border-border transition-colors [&:focus-within]:border-brand/60 pl-1.5 pr-1.5 py-1.5">
              <button onClick={() => agentFileInputRef.current?.click()} title="Attach video/image/audio" className="w-8 h-8 shrink-0 self-end grid place-items-center rounded-full text-fg-subtle hover:text-fg hover:bg-bg-hover">
                <Paperclip size={15} />
              </button>
              <textarea value={agentInput} onChange={(e) => setAgentInput(e.target.value)} rows={1} placeholder="Message the agent"
                onInput={(e) => { const t = e.currentTarget; t.style.height = "auto"; t.style.height = `${Math.min(120, t.scrollHeight)}px`; }}
                onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); const v = agentInput.trim(); if ((v || agentFiles.length) && !agentBusy) { setAgentInput(""); e.currentTarget.style.height = "auto"; void runCanvasAgent(v); } } }}
                className="flex-1 resize-none bg-transparent text-fg outline-none border-0 focus:ring-0 leading-[1.4] py-[5px] max-h-[120px] placeholder:text-fg-subtle" />
              <button disabled={agentBusy || (!agentInput.trim() && !agentFiles.length)} aria-label="Send" title="Send (Enter)"
                onClick={() => { const v = agentInput.trim(); if (v || agentFiles.length) { setAgentInput(""); void runCanvasAgent(v); } }}
                className="w-8 h-8 shrink-0 self-end grid place-items-center rounded-full bg-brand text-white disabled:opacity-35 transition-opacity">
                <ArrowUp size={16} strokeWidth={2.5} />
              </button>
            </div>
          </div>
        </div>
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
