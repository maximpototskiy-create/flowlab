"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Check, AlertCircle } from "lucide-react";

// Reads the App Store URL from the form, calls the autofill API, shows real
// progress + a summary of what was pulled, then refreshes the page so the
// form reflects the new pitch / screenshots / icon.
export default function AppStoreAutofillButton({ brandId }: { brandId: string }) {
  const router = useRouter();
  const [status, setStatus] = useState<"idle" | "loading" | "ok" | "error">("idle");
  const [message, setMessage] = useState("");

  async function run() {
    const input = document.querySelector<HTMLInputElement>('input[name="appStoreUrl"]');
    const appStoreUrl = input?.value?.trim() || "";
    if (!appStoreUrl) {
      setStatus("error");
      setMessage("Вставь ссылку на App Store выше");
      return;
    }
    setStatus("loading");
    setMessage("Получаю данные из App Store…");
    try {
      const res = await fetch("/api/appstore-autofill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brandId, appStoreUrl }),
      });
      const data = await res.json();
      if (!data.ok) {
        setStatus("error");
        setMessage(data.error || "Не получилось");
        return;
      }
      const f = data.found;
      const parts: string[] = [];
      if (f.name) parts.push(f.name);
      parts.push(f.pitchFilled ? "описание ✓" : "описание уже было");
      parts.push(`скриншотов: ${f.screenshots}${f.addedScreenshots ? ` (+${f.addedScreenshots})` : ""}`);
      parts.push(f.icon ? "иконка ✓" : "иконки нет");
      setStatus("ok");
      setMessage(parts.join(" · "));
      router.refresh(); // pull updated pitch/screenshots/icon into the form
    } catch {
      setStatus("error");
      setMessage("Сетевая ошибка");
    }
  }

  return (
    <div className="mt-2 space-y-1.5">
      <button
        type="button"
        onClick={run}
        disabled={status === "loading"}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-brand text-brand text-[11px] hover:bg-brand/10 transition disabled:opacity-60"
      >
        {status === "loading" ? <Loader2 size={12} className="animate-spin" /> : "↓"}
        {status === "loading" ? "Подтягиваю из App Store…" : "Подтянуть из App Store"}
      </button>
      {status !== "idle" && status !== "loading" && (
        <div
          className={`flex items-start gap-1.5 text-[10px] ${
            status === "ok" ? "text-brand" : "text-red-400"
          }`}
        >
          {status === "ok" ? <Check size={11} className="mt-0.5 flex-shrink-0" /> : <AlertCircle size={11} className="mt-0.5 flex-shrink-0" />}
          <span>{message}</span>
        </div>
      )}
      {status === "loading" && <div className="text-[10px] text-fg-subtle">{message}</div>}
    </div>
  );
}
