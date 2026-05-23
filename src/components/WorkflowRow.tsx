// src/components/WorkflowRow.tsx
"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Modal from "./Modal";
import DropdownMenu from "./DropdownMenu";
import StopPropagation from "./StopPropagation";
import { renameWorkflow, deleteWorkflow, duplicateWorkflow } from "@/lib/actions";
import { relativeTime } from "@/lib/format";

export type WorkflowRowData = {
  id: string;
  projectId: string;
  name: string;
  updatedAt: Date;
  graph: unknown;
};

function countNodes(graph: unknown): number {
  try {
    const g = graph as { nodes?: unknown[] };
    return Array.isArray(g?.nodes) ? g.nodes.length : 0;
  } catch {
    return 0;
  }
}

export default function WorkflowRow({ workflow }: { workflow: WorkflowRowData }) {
  const router = useRouter();
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState("");

  const nodeCount = countNodes(workflow.graph);

  function handleRename(formData: FormData) {
    setError("");
    startTransition(async () => {
      try {
        await renameWorkflow(formData);
        setRenameOpen(false);
        router.refresh();
      } catch (e) {
        if (e instanceof Error && !e.message.includes("NEXT_REDIRECT")) {
          setError(e.message);
        }
      }
    });
  }

  function handleDelete() {
    setError("");
    const fd = new FormData();
    fd.append("id", workflow.id);

    router.replace(`/projects/${workflow.projectId}`);

    startTransition(async () => {
      try {
        await deleteWorkflow(fd);
        router.refresh();
      } catch (e) {
        if (e instanceof Error && !e.message.includes("NEXT_REDIRECT")) {
          setError(e.message);
        }
      }
    });
  }

  function handleDuplicate() {
    const fd = new FormData();
    fd.append("id", workflow.id);
    startTransition(async () => {
      try {
        await duplicateWorkflow(fd);
      } catch (e) {
        if (e instanceof Error && !e.message.includes("NEXT_REDIRECT")) {
          setError(e.message);
        }
      }
    });
  }

  return (
    <>
      <Link
        href={`/projects/${workflow.projectId}/workflows/${workflow.id}`}
        className="group flex items-center gap-4 px-5 py-4 bg-bg hover:bg-bg-hover/50 border-b border-border transition"
      >
        <div className="w-9 h-9 rounded-sm bg-bg-subtle border border-border-strong flex items-center justify-center text-fg-subtle group-hover:text-brand group-hover:border-emerald-500/30 transition">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="6" cy="6" r="2" />
            <circle cx="18" cy="18" r="2" />
            <circle cx="6" cy="18" r="2" />
            <line x1="8" y1="6" x2="16" y2="6" />
            <line x1="6" y1="8" x2="6" y2="16" />
            <line x1="8" y1="18" x2="16" y2="18" />
          </svg>
        </div>

        <div className="flex-1 min-w-0">
          <div className="font-display text-lg leading-tight truncate group-hover:text-brand transition">
            {workflow.name}
          </div>
          <div className="font-mono text-[10px] tracking-wider uppercase text-fg-subtle mt-0.5">
            {nodeCount === 0 ? "Empty" : `${nodeCount} node${nodeCount === 1 ? "" : "s"}`} · updated {relativeTime(workflow.updatedAt)}
          </div>
        </div>

        <StopPropagation>
          <DropdownMenu
            trigger="⋯"
            items={[
              { label: "Rename", onClick: () => setRenameOpen(true) },
              { label: "Duplicate", onClick: handleDuplicate },
              { label: "Delete", danger: true, onClick: () => setDeleteOpen(true) },
            ]}
          />
        </StopPropagation>
      </Link>

      <Modal
        open={renameOpen}
        onClose={() => !pending && setRenameOpen(false)}
        title="Rename workflow"
      >
        <form action={handleRename} className="space-y-5">
          <input type="hidden" name="id" value={workflow.id} />
          <div>
            <label className="block font-mono text-[10px] tracking-[0.15em] uppercase text-fg-muted mb-2">
              Workflow name
            </label>
            <input
              name="name"
              type="text"
              defaultValue={workflow.name}
              required
              maxLength={120}
              className="w-full bg-bg-subtle border border-border-strong px-3 py-2.5 text-fg outline-none focus:border-brand rounded-sm transition"
            />
          </div>
          {error && (
            <div className="font-mono text-xs text-red-400 bg-red-500/5 border border-red-500/20 rounded px-3 py-2">
              {error}
            </div>
          )}
          <div className="flex gap-2 justify-end">
            <button
              type="button"
              onClick={() => setRenameOpen(false)}
              disabled={pending}
              className="font-mono text-[10px] tracking-[0.15em] uppercase text-fg-muted hover:text-fg px-4 py-2 transition"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={pending}
              className="bg-brand text-black font-mono text-[10px] tracking-[0.15em] uppercase py-2 px-5 rounded-sm hover:bg-emerald-400 disabled:opacity-50 transition"
            >
              {pending ? "Saving…" : "Save"}
            </button>
          </div>
        </form>
      </Modal>

      <Modal
        open={deleteOpen}
        onClose={() => !pending && setDeleteOpen(false)}
        title="Delete workflow?"
        description={`"${workflow.name}" will be permanently deleted. This cannot be undone.`}
      >
        <div className="space-y-4">
          {error && (
            <div className="font-mono text-xs text-red-400 bg-red-500/5 border border-red-500/20 rounded px-3 py-2">
              {error}
            </div>
          )}
          <div className="flex gap-2 justify-end">
            <button
              type="button"
              onClick={() => setDeleteOpen(false)}
              disabled={pending}
              className="font-mono text-[10px] tracking-[0.15em] uppercase text-fg-muted hover:text-fg px-4 py-2 transition"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleDelete}
              disabled={pending}
              className="bg-red-500/90 text-white font-mono text-[10px] tracking-[0.15em] uppercase py-2 px-5 rounded-sm hover:bg-red-500 disabled:opacity-50 transition"
            >
              {pending ? "Deleting…" : "Delete"}
            </button>
          </div>
        </div>
      </Modal>
    </>
  );
}
