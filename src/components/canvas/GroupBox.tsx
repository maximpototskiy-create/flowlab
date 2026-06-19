"use client";

import { useState } from "react";
import { Network, Ungroup, Trash2, Check } from "lucide-react";
import type { Group } from "@/lib/canvas/types";

// The visual box around a group of nodes. Sits behind the nodes; its header
// (label + controls) sits at the top edge. Dragging the box body moves the
// whole group (handled by the parent via onBoxPointerDown → startGroupDrag).
// Controls: rename (click the label), recolour, organize-in-place, ungroup,
// delete-with-nodes.
export default function GroupBox({
  group,
  rgb,
  colorKeys,
  colorMap,
  allSelected,
  spaceHeld,
  rect,
  onBoxPointerDown,
  onRename,
  onColor,
  onOrganize,
  onUngroup,
  onDelete,
}: {
  group: Group;
  rgb: string; // "r g b"
  colorKeys: string[];
  colorMap: Record<string, string>;
  allSelected: boolean;
  spaceHeld: boolean;
  rect: { left: number; top: number; width: number; height: number };
  onBoxPointerDown: (e: React.PointerEvent) => void;
  onRename: (label: string) => void;
  onColor: (color: string) => void;
  onOrganize: () => void;
  onUngroup: () => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(group.label ?? "Group");
  const [showColors, setShowColors] = useState(false);

  const stop = (e: React.PointerEvent | React.MouseEvent) => e.stopPropagation();

  return (
    <div
      data-group-box={group.id}
      onPointerDown={(e) => {
        // Pan gestures pass through to the canvas.
        if (e.button !== 0 || e.altKey || spaceHeld) return;
        onBoxPointerDown(e);
      }}
      className="absolute rounded-xl border border-dashed cursor-move group/box"
      style={{
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        borderColor: `rgb(${rgb} / ${allSelected ? 0.9 : 0.4})`,
        background: `rgb(${rgb} / ${allSelected ? 0.1 : 0.05})`,
      }}
    >
      {/* Header bar */}
      <div className="flex items-center gap-1 px-2 h-[24px]">
        {/* Label / inline edit */}
        {editing ? (
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onPointerDown={stop}
            onMouseDown={stop}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") {
                onRename(draft.trim() || "Group");
                setEditing(false);
              } else if (e.key === "Escape") {
                setDraft(group.label ?? "Group");
                setEditing(false);
              }
            }}
            onBlur={() => {
              onRename(draft.trim() || "Group");
              setEditing(false);
            }}
            className="bg-bg-card/80 border border-border rounded px-1 py-0.5 text-[10px] text-fg outline-none w-32 nodrag"
            style={{ color: `rgb(${rgb})` }}
          />
        ) : (
          <button
            onPointerDown={stop}
            onClick={(e) => {
              stop(e);
              setDraft(group.label ?? "Group");
              setEditing(true);
            }}
            className="text-[10px] font-medium select-none hover:underline"
            style={{ color: `rgb(${rgb})` }}
            title="Rename group"
          >
            {group.label ?? "Group"}
          </button>
        )}

        {/* Controls — visible on hover or when the group is selected */}
        <div
          className={`ml-auto flex items-center gap-0.5 transition-opacity ${
            allSelected ? "opacity-100" : "opacity-0 group-hover/box:opacity-100"
          }`}
        >
          {/* Colour picker */}
          <div className="relative">
            <button
              onPointerDown={stop}
              onClick={(e) => {
                stop(e);
                setShowColors((v) => !v);
              }}
              className="w-3.5 h-3.5 rounded-full border border-white/30"
              style={{ background: `rgb(${rgb})` }}
              title="Group colour"
            />
            {showColors && (
              <div
                className="absolute top-5 left-0 z-30 flex gap-1 p-1 glass r-sm"
                onPointerDown={stop}
              >
                {colorKeys.map((k) => (
                  <button
                    key={k}
                    onClick={(e) => {
                      stop(e);
                      onColor(k);
                      setShowColors(false);
                    }}
                    className="w-4 h-4 rounded-full border border-white/20 flex items-center justify-center"
                    style={{ background: `rgb(${colorMap[k]})` }}
                  >
                    {(group.color ?? "brand") === k && <Check size={9} className="text-white" />}
                  </button>
                ))}
              </div>
            )}
          </div>
          {/* Organize members in place */}
          <button
            onPointerDown={stop}
            onClick={(e) => { stop(e); onOrganize(); }}
            className="w-5 h-5 rounded flex items-center justify-center text-fg-subtle hover:text-fg hover:bg-bg-hover"
            title="Organize nodes in this group"
          >
            <Network size={11} />
          </button>
          {/* Ungroup (keep nodes) */}
          <button
            onPointerDown={stop}
            onClick={(e) => { stop(e); onUngroup(); }}
            className="w-5 h-5 rounded flex items-center justify-center text-fg-subtle hover:text-fg hover:bg-bg-hover"
            title="Ungroup (keep nodes)"
          >
            <Ungroup size={11} />
          </button>
          {/* Delete group + nodes */}
          <button
            onPointerDown={stop}
            onClick={(e) => { stop(e); onDelete(); }}
            className="w-5 h-5 rounded flex items-center justify-center text-fg-subtle hover:text-rose-500 hover:bg-bg-hover"
            title="Delete group and its nodes"
          >
            <Trash2 size={11} />
          </button>
        </div>
      </div>
    </div>
  );
}
