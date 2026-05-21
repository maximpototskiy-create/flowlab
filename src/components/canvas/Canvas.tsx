"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  NODE_TYPES, PORT_COLORS, makeNode, makeEdge, portsCompatible,
  type Graph, type GraphNode, type PortKind, EMPTY_GRAPH,
} from "@/lib/canvas/types";
import CanvasNode, { NODE_WIDTH } from "./CanvasNode";
import CanvasEdges from "./CanvasEdges";
import NodePalette from "./NodePalette";
import ContextMenu from "./ContextMenu";
import ConnectionPicker from "./ConnectionPicker";
import NodeExpandedModal from "./NodeExpandedModal";
import CanvasToolbar from "./CanvasToolbar";
import RunsPanel, { type RunSummary } from "./RunsPanel";
import { saveWorkflowGraph } from "@/lib/actions";
import { Minus, Plus, Maximize, Grid3X3 } from "lucide-react";

type Drag = { nodeId: string; startX: number; startY: number; pointerX: number; pointerY: number };
type EdgeDraft = {
  fromNode: string;
  fromPort: string;
  fromKind: PortKind;
  x1: number; y1: number; x2: number; y2: number;
};

const STORAGE_AREA = { width: 5000, height: 4000 };

export default function Canvas({
  workflowId,
  workflowName,
  workflowMeta,
  initialGraph,
}: {
  workflowId: string;
  workflowName: string;
  workflowMeta: { brandId: string | null; brandSlug: string | null; projectId: string };
  initialGraph: Graph;
}) {
  // ─────────────────────────────── Graph state
  const [graph, setGraph] = useState<Graph>(() =>
    initialGraph?.nodes ? initialGraph : EMPTY_GRAPH,
  );
  const [selected, setSelected] = useState<string | null>(null);

  // ─────────────────────────────── Save state
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const skipNextSave = useRef(true); // skip first save (we just loaded the graph)

  // ─────────────────────────────── Pan/Zoom
  const [pan, setPan] = useState({ x: 200, y: 100 });
  const [zoom, setZoom] = useState(1);
  const canvasRef = useRef<HTMLDivElement>(null);
  const [isPanning, setIsPanning] = useState(false);
  const panStart = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);

  // ─────────────────────────────── Drag
  const [drag, setDrag] = useState<Drag | null>(null);
  // Live drag position — updated every animation frame for INSTANT visual response.
  // We mutate the DOM transform directly instead of going through React state on each frame.
  // Only commit to setGraph on pointer up.
  const liveDragPos = useRef<{ x: number; y: number } | null>(null);
  // Tick increments on every drag frame to make edges re-render with the new position.
  // (Nodes themselves use direct DOM transform — no React re-render needed.)
  const [dragTick, setDragTick] = useState(0);

  // ─────────────────────────────── Edge draft
  const [edgeDraft, setEdgeDraft] = useState<EdgeDraft | null>(null);

  // ─────────────────────────────── Context menu & pickers
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; canvasX: number; canvasY: number } | null>(null);
  const [connPicker, setConnPicker] = useState<{
    screenX: number; screenY: number; canvasX: number; canvasY: number;
    fromNode: string; fromPort: string; fromKind: PortKind;
  } | null>(null);

  // ─────────────────────────────── Hovered edge
  const [hoveredEdge, setHoveredEdge] = useState<string | null>(null);

  // ─────────────────────────────── Expanded modal
  const [expandedNodeId, setExpandedNodeId] = useState<string | null>(null);

  // ─────────────────────────────── Runs
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const activeRunPoll = useRef<Map<string, ReturnType<typeof setInterval>>>(new Map());

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
        // Strip runtime state before saving
        const cleaned: Graph = {
          nodes: graph.nodes.map((n) => ({
            id: n.id,
            type: n.type,
            position: n.position,
            config: n.config,
          })),
          edges: graph.edges,
        };
        await saveWorkflowGraph(workflowId, cleaned);
        setSaveState("saved");
        setTimeout(() => setSaveState("idle"), 1200);
      } catch {
        setSaveState("error");
      }
    }, 800);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [graph.nodes, graph.edges, workflowId]);

  // ─────────────────────────────── Mutators
  const addNodeAt = useCallback(
    (type: string, canvasX: number, canvasY: number, opts?: { connectFrom?: { node: string; port: string }; toInput?: string }) => {
      const newNode = makeNode(type, { x: canvasX - NODE_WIDTH / 2, y: canvasY - 30 });
      setGraph((g) => {
        const next: Graph = { nodes: [...g.nodes, newNode], edges: g.edges };
        if (opts?.connectFrom && opts.toInput) {
          next.edges = [...next.edges, makeEdge(opts.connectFrom.node, opts.connectFrom.port, newNode.id, opts.toInput)];
        }
        return next;
      });
      setSelected(newNode.id);
    },
    [],
  );

  const deleteNode = useCallback((nodeId: string) => {
    setGraph((g) => ({
      nodes: g.nodes.filter((n) => n.id !== nodeId),
      edges: g.edges.filter((e) => e.from.nodeId !== nodeId && e.to.nodeId !== nodeId),
    }));
    if (selected === nodeId) setSelected(null);
    if (expandedNodeId === nodeId) setExpandedNodeId(null);
  }, [selected, expandedNodeId]);

  const deleteEdge = useCallback((edgeId: string) => {
    setGraph((g) => ({ ...g, edges: g.edges.filter((e) => e.id !== edgeId) }));
  }, []);

  const updateNodeConfig = useCallback((nodeId: string, key: string, value: unknown) => {
    setGraph((g) => ({
      ...g,
      nodes: g.nodes.map((n) => (n.id === nodeId ? { ...n, config: { ...n.config, [key]: value } } : n)),
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
    setDrag({
      nodeId,
      startX: node.position.x,
      startY: node.position.y,
      pointerX: e.clientX,
      pointerY: e.clientY,
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
    // Match CanvasEdges port calculation: NODE_HEADER_HEIGHT(38) + 14 + PORT_RADIUS(7) + idx*spacing(26)
    const portYpx = 38 + 14 + 7 + portIdx * 26;
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
    // Remove existing edge to this input (single connection per input)
    setGraph((g) => ({
      ...g,
      edges: [
        ...g.edges.filter((e2) => !(e2.to.nodeId === nodeId && e2.to.port === portName)),
        makeEdge(edgeDraft.fromNode, edgeDraft.fromPort, nodeId, portName),
      ],
    }));
    setEdgeDraft(null);
  }

  // ─────────────────────────────── Global pointermove/up
  const rafPending = useRef(false);
  const lastPointer = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    function applyDrag() {
      rafPending.current = false;
      const ptr = lastPointer.current;
      if (!ptr) return;
      if (drag) {
        const dx = (ptr.x - drag.pointerX) / zoom;
        const dy = (ptr.y - drag.pointerY) / zoom;
        const newX = drag.startX + dx;
        const newY = drag.startY + dy;
        liveDragPos.current = { x: newX, y: newY };
        // Direct DOM update — no React re-render of nodes during drag
        const el = document.querySelector(`[data-node-id="${drag.nodeId}"]`) as HTMLElement | null;
        if (el) {
          el.style.transform = `translate(${newX}px, ${newY}px)`;
        }
        // Edges still need re-render but it's cheap — they're SVG paths.
        // Tick increments — CanvasEdges reads liveDragPos.current via the ref.
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
    }

    function onMove(e: PointerEvent) {
      lastPointer.current = { x: e.clientX, y: e.clientY };
      if (!rafPending.current && (drag || edgeDraft || isPanning)) {
        rafPending.current = true;
        requestAnimationFrame(applyDrag);
      }
    }
    function onUp(e: PointerEvent) {
      if (drag) {
        // Commit final position to graph state — this triggers React re-render once.
        const finalPos = liveDragPos.current;
        if (finalPos) {
          setGraph((g) => ({
            ...g,
            nodes: g.nodes.map((n) =>
              n.id === drag.nodeId
                ? { ...n, position: { x: finalPos.x, y: finalPos.y } }
                : n,
            ),
          }));
        }
        liveDragPos.current = null;
        setDrag(null);
      }
      if (edgeDraft) {
        // Check if released over an input port via document.elementFromPoint
        const target = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
        const portEl = target?.closest?.("[data-port-side]");
        if (portEl?.getAttribute("data-port-side") === "in") {
          // input port handler will catch it via pointerup
        } else {
          // Open ConnectionPicker
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
          return;
        }
        setEdgeDraft(null);
      }
      if (isPanning) {
        setIsPanning(false);
        panStart.current = null;
      }
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [drag, edgeDraft, isPanning, zoom, screenToCanvas]);

  // ─────────────────────────────── Keyboard shortcuts
  const clipboard = useRef<GraphNode | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // Ignore when typing in input/textarea
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      const meta = e.metaKey || e.ctrlKey;

      // Delete / Backspace → delete selected
      if ((e.key === "Delete" || e.key === "Backspace") && selected && !expandedNodeId) {
        e.preventDefault();
        deleteNode(selected);
        return;
      }

      // Escape → clear selection, close menus
      if (e.key === "Escape") {
        setSelected(null);
        setCtxMenu(null);
        setConnPicker(null);
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

      // Cmd/Ctrl+D → duplicate selected (copy+paste in one shot)
      if (meta && e.key.toLowerCase() === "d" && selected) {
        e.preventDefault();
        const src = graph.nodes.find((x) => x.id === selected);
        if (src) {
          const newNode = makeNode(src.type, { x: src.position.x + 30, y: src.position.y + 30 });
          newNode.config = JSON.parse(JSON.stringify(src.config));
          setGraph((g) => ({ ...g, nodes: [...g.nodes, newNode] }));
          setSelected(newNode.id);
        }
        return;
      }

      // Cmd/Ctrl+Enter → run selected node
      if (meta && e.key === "Enter" && selected) {
        e.preventDefault();
        startRun(selected);
        return;
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [selected, expandedNodeId, deleteNode, graph.nodes, ]);

  // ─────────────────────────────── Pan & background interaction
  function onCanvasPointerDown(e: React.PointerEvent) {
    if (e.button === 1 || (e.button === 0 && e.altKey) || e.button === 2) {
      // Middle-click or alt+left or right (right = ctx menu, handled below)
      if (e.button !== 2) {
        setIsPanning(true);
        panStart.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
      }
      return;
    }
    if (e.target === e.currentTarget || (e.target as HTMLElement).classList.contains("canvas-bg-hit")) {
      setSelected(null);
    }
  }

  function onCanvasContextMenu(e: React.MouseEvent) {
    e.preventDefault();
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
      // Ctrl/Cmd + wheel → zoom (pinch-zoom on mac sends ctrlKey=true)
      if (e.ctrlKey || e.metaKey) {
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
      // Otherwise: trackpad two-finger scroll → pan
      e.preventDefault();
      setPan((p) => ({ x: p.x - e.deltaX, y: p.y - e.deltaY }));
    }

    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);


  // ─────────────────────────────── File upload helper (used by upload nodes)
  async function uploadFile(file: File): Promise<{ cdnUrl: string }> {
    const fd = new FormData();
    fd.append("file", file);
    if (workflowMeta.brandId) fd.append("brandId", workflowMeta.brandId);
    fd.append("projectId", workflowMeta.projectId);
    fd.append("workflowId", workflowId);
    const res = await fetch("/api/upload", { method: "POST", body: fd });
    if (!res.ok) throw new Error("Upload failed");
    return (await res.json()) as { cdnUrl: string };
  }

  // ─────────────────────────────── Run execution
  async function startRun(scopeNodeId?: string) {
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
      pollRun(runId);
    } catch (err) {
      console.error(err);
      // Reset the scoped nodes back to idle so user can retry
      setGraph((g) => ({
        ...g,
        nodes: g.nodes.map((n) =>
          scopeNodeId && n.id !== scopeNodeId ? n : { ...n, status: "error", error: err instanceof Error ? err.message : "Run failed" },
        ),
      }));
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

  function pollRun(runId: string) {
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/runs/${runId}`, { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as {
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

        // Update node statuses & outputs
        setGraph((g) => ({
          ...g,
          nodes: g.nodes.map((n) => {
            const step = data.steps.find((s) => s.nodeId === n.id);
            if (!step) return n;
            const assets = step.assets ?? [];
            return {
              ...n,
              status: step.status,
              outputs: step.outputData ?? n.outputs,
              error: step.errorMessage ?? undefined,
              results: assets.length > 1 ? assets.map((a) => ({ value: a.cdnUrl, mime: a.kind })) : undefined,
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
          if (activeRunPoll.current.size === 0) setIsRunning(false);
        }
      } catch (err) {
        console.error("Poll error:", err);
      }
    }, 3000);
    activeRunPoll.current.set(runId, interval);
  }

  useEffect(() => {
    const map = activeRunPoll.current;
    return () => {
      for (const i of map.values()) clearInterval(i);
    };
  }, []);

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
          style={{ cursor: isPanning ? "grabbing" : drag ? "grabbing" : "default" }}
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
            <CanvasEdges
              key={`edges-${dragTick}`}
              graph={graph}
              hoveredEdgeId={hoveredEdge}
              draftEdge={edgeDraft ? { x1: edgeDraft.x1, y1: edgeDraft.y1, x2: edgeDraft.x2, y2: edgeDraft.y2, color: PORT_COLORS[edgeDraft.fromKind] } : null}
              liveDragNodeId={drag?.nodeId ?? null}
              liveDragPos={liveDragPos.current}
              onHover={setHoveredEdge}
              onDelete={deleteEdge}
            />

            {graph.nodes.map((node) => (
              <CanvasNode
                key={node.id}
                node={node}
                isSelected={selected === node.id}
                isRunning={isRunning}
                onPointerDown={(e) => startNodeDrag(node.id, e)}
                onOutputPortDown={(portId, e) => startEdge(node.id, portId, e)}
                onInputPortUp={(portId, e) => endEdgeOnInput(node.id, portId, e)}
                onSelect={() => setSelected(node.id)}
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
              />
            ))}
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
              className="w-7 h-7 rounded-full flex items-center justify-center hover:bg-bg-hover text-fg-muted"
              title="Zoom out"
            >
              <Minus size={12} />
            </button>
            <span className="text-[10px] text-fg-muted px-1 tabular-nums">{Math.round(zoom * 100)}%</span>
            <button
              onClick={() => setZoom((z) => Math.min(2, z + 0.1))}
              className="w-7 h-7 rounded-full flex items-center justify-center hover:bg-bg-hover text-fg-muted"
              title="Zoom in"
            >
              <Plus size={12} />
            </button>
            <div className="w-px h-4 bg-border mx-1" />
            <button
              onClick={() => { setZoom(1); setPan({ x: 200, y: 100 }); }}
              className="w-7 h-7 rounded-full flex items-center justify-center hover:bg-bg-hover text-fg-muted"
              title="Reset view"
            >
              <Maximize size={11} />
            </button>
          </div>

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

      {/* Connection picker */}
      {connPicker && (
        <ConnectionPicker
          x={connPicker.screenX}
          y={connPicker.screenY}
          sourceKind={connPicker.fromKind}
          onClose={() => setConnPicker(null)}
          onPick={(type, inputPort) => {
            addNodeAt(type, connPicker.canvasX, connPicker.canvasY, {
              connectFrom: { node: connPicker.fromNode, port: connPicker.fromPort },
              toInput: inputPort,
            });
            setConnPicker(null);
          }}
        />
      )}

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
