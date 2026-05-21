// src/components/CreateBrandButton.tsx
"use client";

import { useState, useTransition } from "react";
import Modal from "./Modal";
import { createBrand } from "@/lib/actions";

export default function CreateBrandButton({
  variant = "primary",
}: {
  variant?: "primary" | "ghost";
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState("");

  async function handleSubmit(formData: FormData) {
    setError("");
    startTransition(async () => {
      try {
        await createBrand(formData);
      } catch (e) {
        if (e instanceof Error && !e.message.includes("NEXT_REDIRECT")) {
          setError(e.message);
        }
      }
    });
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className={
          variant === "primary"
            ? "bg-brand text-black font-mono text-xs tracking-[0.15em] uppercase py-3 px-5 rounded-sm hover:bg-emerald-400 transition"
            : "font-mono text-[11px] tracking-[0.15em] uppercase text-fg-muted hover:text-fg border border-border-strong hover:border-border-strong px-4 py-2 rounded-sm transition"
        }
      >
        + New brand
      </button>

      <Modal
        open={open}
        onClose={() => !pending && setOpen(false)}
        title="Create a new brand"
        description="A brand is a mobile app or product. Each brand has its own projects, workflows, and brand kit."
      >
        <form action={handleSubmit} className="space-y-5">
          <div>
            <label className="block font-mono text-[10px] tracking-[0.15em] uppercase text-fg-muted mb-2">
              Brand name
            </label>
            <input
              name="name"
              type="text"
              required
              maxLength={80}
              placeholder="e.g. Cleaner Pro"
              className="w-full bg-bg-subtle border border-border-strong px-3 py-2.5 text-white outline-none focus:border-brand rounded-sm transition"
            />
          </div>
          <div>
            <label className="block font-mono text-[10px] tracking-[0.15em] uppercase text-fg-muted mb-2">
              Description <span className="text-fg-subtle normal-case">(optional)</span>
            </label>
            <textarea
              name="description"
              rows={3}
              maxLength={500}
              placeholder="What kind of app is this?"
              className="w-full bg-bg-subtle border border-border-strong px-3 py-2.5 text-white outline-none focus:border-brand rounded-sm transition resize-none"
            />
          </div>
          {error && (
            <div className="font-mono text-xs text-red-400 bg-red-500/5 border border-red-500/20 rounded px-3 py-2">
              {error}
            </div>
          )}
          <div className="flex gap-2 justify-end pt-2">
            <button
              type="button"
              onClick={() => setOpen(false)}
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
              {pending ? "Creating…" : "Create brand →"}
            </button>
          </div>
        </form>
      </Modal>
    </>
  );
}
