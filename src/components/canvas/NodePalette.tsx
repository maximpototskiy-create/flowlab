"use client";

import { useMemo, useState } from "react";
import { Search, Plus, ChevronDown, ChevronRight } from "lucide-react";
import {
  NODE_TYPES, CATEGORY_LABELS, CATEGORY_DESC, CATEGORY_ORDER, CATEGORY_COLORS,
  QUICK_ACTIONS, type NodeCategory,
} from "@/lib/canvas/types";
import { NodeIcon } from "@/lib/canvas/icons";

export default function NodePalette({
  onAdd,
}: {
  onAdd: (type: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Record<NodeCategory, boolean>>({
    text: false, image: false, video: false, audio: false,
    structural: true, integration: true, tools: true,
  });

  const filtered = useMemo(() => {
    if (!query.trim()) return null;
    const q = query.toLowerCase();
    return Object.entries(NODE_TYPES)
      .filter(([, d]) => d.name.toLowerCase().includes(q) || d.description.toLowerCase().includes(q))
      .map(([id, d]) => ({ id, def: d }));
  }, [query]);

  return (
    <div className="w-56 shrink-0 glass-strong flex flex-col">
      {/* Search */}
      <div className="p-2.5 border-b border-border">
        <div className="relative">
          <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-subtle" strokeWidth={1.5} />
          <input
            type="text"
            placeholder="Search nodes…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full bg-bg-subtle border border-border rounded-md pl-7 pr-2 py-1.5 text-[11px] text-fg outline-none focus:border-brand placeholder:text-fg-subtle"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-1 py-2">
        {filtered ? (
          <div className="space-y-0.5">
            {filtered.map(({ id, def }) => (
              <button
                key={id}
                onClick={() => onAdd(id)}
                className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md hover:bg-bg-hover text-left text-fg-muted hover:text-fg group"
              >
                <NodeIcon name={def.icon} size={12} style={{ color: CATEGORY_COLORS[def.category] }} />
                <div className="flex-1 min-w-0">
                  <div className="text-[11px] truncate">{def.name}</div>
                </div>
              </button>
            ))}
            {filtered.length === 0 && (
              <div className="px-3 py-3 text-[10px] text-fg-subtle italic">No matches</div>
            )}
          </div>
        ) : (
          <>
            {/* Quick Actions */}
            <div className="mb-3 px-1">
              <div className="px-2 mb-1.5 text-[9px] uppercase tracking-wider text-fg-subtle font-semibold">
                Generate
              </div>
              <div className="grid grid-cols-2 gap-1 px-1">
                {QUICK_ACTIONS.filter((a) => a.group === "generate").map((a) => (
                  <button
                    key={a.id}
                    onClick={() => onAdd(a.type)}
                    className="flex items-center gap-1.5 px-2 py-1.5 rounded-md border border-border bg-bg-card hover:bg-bg-hover hover:border-border-strong text-[10px] text-fg-muted hover:text-fg"
                  >
                    <NodeIcon name={a.icon} size={11} />
                    <span className="truncate">{a.label}</span>
                  </button>
                ))}
              </div>

              <div className="px-2 mt-3 mb-1.5 text-[9px] uppercase tracking-wider text-fg-subtle font-semibold">
                Add your
              </div>
              <div className="grid grid-cols-2 gap-1 px-1">
                {QUICK_ACTIONS.filter((a) => a.group === "add").map((a) => (
                  <button
                    key={a.id}
                    onClick={() => onAdd(a.type)}
                    className="flex items-center gap-1.5 px-2 py-1.5 rounded-md border border-border bg-bg-card hover:bg-bg-hover hover:border-border-strong text-[10px] text-fg-muted hover:text-fg"
                  >
                    <NodeIcon name={a.icon} size={11} />
                    <span className="truncate">{a.label}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Categorized list */}
            <div className="border-t border-border pt-2">
              {CATEGORY_ORDER.map((cat) => {
                const isCollapsed = collapsed[cat];
                const nodes = Object.entries(NODE_TYPES).filter(([, d]) => d.category === cat);
                if (nodes.length === 0) return null;
                return (
                  <div key={cat} className="mb-1">
                    <button
                      onClick={() => setCollapsed((s) => ({ ...s, [cat]: !s[cat] }))}
                      className="w-full flex items-center gap-1 px-2 py-1 text-[9px] uppercase tracking-wider text-fg-subtle hover:text-fg font-semibold"
                    >
                      {isCollapsed ? <ChevronRight size={9} /> : <ChevronDown size={9} />}
                      <span>{CATEGORY_LABELS[cat]}</span>
                      <span className="ml-auto opacity-50">{nodes.length}</span>
                    </button>
                    {!isCollapsed && (
                      <div className="space-y-0">
                        {nodes.map(([id, def]) => (
                          <button
                            key={id}
                            onClick={() => onAdd(id)}
                            className="w-full flex items-center gap-2 px-3 py-1 rounded-md hover:bg-bg-hover text-left text-fg-muted hover:text-fg group border-l-2 border-transparent hover:border-brand"
                          >
                            <NodeIcon name={def.icon} size={11} style={{ color: CATEGORY_COLORS[cat] }} />
                            <span className="text-[11px] truncate">{def.name}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
