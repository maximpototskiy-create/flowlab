// src/components/LogoutButton.tsx
"use client";

import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";
import { useState } from "react";

export default function LogoutButton() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function handleLogout() {
    setLoading(true);
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <button
      onClick={handleLogout}
      disabled={loading}
      className="text-[12px] font-medium text-fg-muted hover:text-fg disabled:opacity-50 transition border border-[rgb(var(--hairline)/var(--hairline-alpha))] hover:bg-bg-hover px-3 py-1.5 rounded-lg"
    >
      {loading ? "Signing out…" : "Sign out"}
    </button>
  );
}
