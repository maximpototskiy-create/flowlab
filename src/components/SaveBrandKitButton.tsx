"use client";

import { useFormStatus } from "react-dom";
import { useEffect, useState } from "react";
import { Loader2, Check } from "lucide-react";

// Submit button with visible state: idle → "Saving…" → "Saved ✓".
// useFormStatus tracks the parent server-action form submission.
export default function SaveBrandKitButton() {
  const { pending } = useFormStatus();
  const [justSaved, setJustSaved] = useState(false);
  const [wasPending, setWasPending] = useState(false);

  useEffect(() => {
    if (pending) {
      setWasPending(true);
      setJustSaved(false);
    } else if (wasPending) {
      // Transition from pending → done = a save just completed.
      setWasPending(false);
      setJustSaved(true);
      const t = setTimeout(() => setJustSaved(false), 2500);
      return () => clearTimeout(t);
    }
  }, [pending, wasPending]);

  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex items-center gap-1.5 px-5 py-2 bg-fg text-bg rounded-md text-[12px] font-medium hover:opacity-90 disabled:opacity-70"
    >
      {pending && <Loader2 size={13} className="animate-spin" />}
      {justSaved && <Check size={13} />}
      {pending ? "Saving…" : justSaved ? "Saved" : "Save Brand Kit"}
    </button>
  );
}
