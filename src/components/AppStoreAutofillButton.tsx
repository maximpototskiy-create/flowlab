"use client";

import { useFormStatus } from "react-dom";

// Submit button for the App Store autofill action. Uses useFormStatus to show
// progress while the server action runs (the form submit is otherwise silent).
export default function AppStoreAutofillButton({ formAction }: { formAction: (fd: FormData) => void | Promise<void> }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      formAction={formAction}
      disabled={pending}
      className="mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-brand text-brand text-[11px] hover:bg-brand/10 transition disabled:opacity-60"
    >
      {pending ? "Подтягиваю из App Store…" : "↓ Подтянуть из App Store"}
    </button>
  );
}
