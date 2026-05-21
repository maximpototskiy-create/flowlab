// src/components/BrandActions.tsx
"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Modal from "./Modal";
import DropdownMenu from "./DropdownMenu";
import { renameBrand, deleteBrand } from "@/lib/actions";

export default function BrandActions({
  brand,
  variant = "compact",
}: {
  brand: { id: string; name: string; description: string | null };
  variant?: "compact" | "inline";
}) {
  const router = useRouter();
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState("");

  function handleRename(formData: FormData) {
    setError("");
    startTransition(async () => {
      try {
        await renameBrand(formData);
        setRenameOpen(false);
        router.refresh();
      } catch (e) {
        if (e instanceof Error) setError(e.message);
      }
    });
  }

  function handleDelete() {
    setError("");
    const fd = new FormData();
    fd.append("id", brand.id);

    router.replace("/brands");
    startTransition(async () => {
      try {
        await deleteBrand(fd);
        router.refresh();
      } catch (e) {
        if (e instanceof Error) setError(e.message);
      }
    });
  }

  const modals = (
    <>
      <Modal
        open={renameOpen}
        onClose={() => !pending && setRenameOpen(false)}
        title="Rename brand"
      >
        <form action={handleRename} className="space-y-5">
          <input type="hidden" name="id" value={brand.id} />
          <div>
            <label className="block font-mono text-[10px] tracking-[0.15em] uppercase text-fg-muted mb-2">
              Brand name
            </label>
            <input
              name="name"
              type="text"
              defaultValue={brand.name}
              required
              maxLength={80}
              className="w-full bg-bg-subtle border border-border-strong px-3 py-2.5 text-white outline-none focus:border-brand rounded-sm transition"
            />
          </div>
          <div>
            <label className="block font-mono text-[10px] tracking-[0.15em] uppercase text-fg-muted mb-2">
              Description
            </label>
            <textarea
              name="description"
              rows={3}
              maxLength={500}
              defaultValue={brand.description ?? ""}
              className="w-full bg-bg-subtle border border-border-strong px-3 py-2.5 text-white outline-none focus:border-brand rounded-sm transition resize-none"
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
        title="Delete brand?"
        description={`"${brand.name}" and ALL its projects, workflows, brand kit and assets will be permanently deleted. This cannot be undone.`}
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
              {pending ? "Deleting…" : "Delete brand"}
            </button>
          </div>
        </div>
      </Modal>
    </>
  );

  if (variant === "inline") {
    return (
      <>
        <div className="flex gap-2">
          <button
            onClick={() => setRenameOpen(true)}
            className="font-mono text-[10px] tracking-[0.15em] uppercase text-fg-muted hover:text-fg border border-border-strong hover:border-border-strong px-3 py-1.5 rounded-sm transition"
          >
            Edit
          </button>
          <button
            onClick={() => setDeleteOpen(true)}
            className="font-mono text-[10px] tracking-[0.15em] uppercase text-red-400 hover:text-red-300 border border-red-500/30 hover:border-red-500/60 px-3 py-1.5 rounded-sm transition"
          >
            Delete
          </button>
        </div>
        {modals}
      </>
    );
  }

  return (
    <>
      <DropdownMenu
        trigger="⋯"
        items={[
          { label: "Rename", onClick: () => setRenameOpen(true) },
          { label: "Delete brand", danger: true, onClick: () => setDeleteOpen(true) },
        ]}
      />
      {modals}
    </>
  );
}
