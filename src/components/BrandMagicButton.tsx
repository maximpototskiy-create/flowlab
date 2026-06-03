"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Wand2 } from "lucide-react";

type Found = {
  appStoreUrl?: string;
  googlePlayUrl?: string;
  screenshots?: number;
  addedScreenshots?: number;
  icon?: boolean;
  audience?: string;
  competitors?: string[];
  summary?: string;
};
type Source = { url: string; title?: string };

// One-shot brand autofill: finds the store listing, pulls assets, researches
// the brand on the web, and fills the whole kit (in English). Manual fields
// stay editable.
export default function BrandMagicButton({ brandId }: { brandId: string }) {
  const router = useRouter();
  const [status, setStatus] = useState<"idle" | "loading" | "ok" | "error">("idle");
  const [message, setMessage] = useState("");
  const [steps, setSteps] = useState<string[]>([]);
  const [found, setFound] = useState<Found | null>(null);
  const [sources, setSources] = useState<Source[]>([]);
  const [filled, setFilled] = useState<string[]>([]);

  async function run() {
    setStatus("loading");
    setMessage("Ищу приложение, тяну данные и исследую бренд… до ~40 сек");
    setSteps([]);
    setFound(null);
    setSources([]);
    setFilled([]);
    try {
      const res = await fetch("/api/brand-magic", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brandId }),
      });
      const data = await res.json();
      if (!data.ok) {
        setStatus("error");
        setMessage(data.error || "Не получилось");
        setSteps(data.steps || []);
        return;
      }
      setStatus("ok");
      setMessage("");
      setSteps(data.steps || []);
      setFound(data.found || null);
      setSources(data.sources || []);
      setFilled(data.filled || []);
      router.refresh();
    } catch {
      setStatus("error");
      setMessage("Сетевая ошибка или таймаут");
    }
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={run}
        disabled={status === "loading"}
        className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-brand text-black font-semibold text-[12px] hover:bg-emerald-400 transition disabled:opacity-60"
      >
        {status === "loading" ? <Loader2 size={14} className="animate-spin" /> : <Wand2 size={14} />}
        {status === "loading" ? "Магия в процессе…" : "✨ Заполнить всё автоматически"}
      </button>
      <p className="text-[10px] text-fg-subtle">
        Найдёт приложение в App Store/Google Play, подтянет описание, скриншоты и иконку, исследует бренд в сети и заполнит поля (на английском). Поля можно править вручную.
      </p>

      {status === "loading" && <p className="text-[10px] text-fg-muted">{message}</p>}
      {status === "error" && (
        <div className="text-[10px] text-red-400">
          {message}
          {steps.length > 0 && <div className="text-fg-subtle mt-0.5">{steps.join(" · ")}</div>}
        </div>
      )}

      {status === "ok" && (
        <div className="border border-border rounded-md p-3 space-y-2 text-[11px]">
          {steps.length > 0 && <p className="text-fg-subtle text-[10px]">{steps.join(" · ")}</p>}
          {filled.length > 0 && <p className="text-brand text-[10px]">Заполнено: {filled.join(", ")}</p>}
          {found?.summary && (
            <div>
              <div className="text-[9px] uppercase tracking-wider text-fg-subtle mb-0.5">Summary</div>
              <p className="text-fg-muted">{found.summary}</p>
            </div>
          )}
          {found?.audience && (
            <div>
              <div className="text-[9px] uppercase tracking-wider text-fg-subtle mb-0.5">Audience</div>
              <p className="text-fg-muted">{found.audience}</p>
            </div>
          )}
          {found?.competitors && found.competitors.length > 0 && (
            <div>
              <div className="text-[9px] uppercase tracking-wider text-fg-subtle mb-0.5">Competitors</div>
              <p className="text-fg-muted">{found.competitors.join(" · ")}</p>
            </div>
          )}
          <p className="text-[10px] text-fg-subtle">
            Скриншотов: {found?.screenshots ?? 0}
            {found?.addedScreenshots ? ` (+${found.addedScreenshots})` : ""} · иконка {found?.icon ? "✓" : "—"}
            {found?.googlePlayUrl ? " · Google Play ✓" : ""}
          </p>
          {sources.length > 0 && (
            <div className="pt-1.5 border-t border-border">
              <div className="text-[9px] uppercase tracking-wider text-fg-subtle mb-0.5">Источники</div>
              <ul className="space-y-0.5">
                {sources.slice(0, 8).map((s, i) => (
                  <li key={i}>
                    <a href={s.url} target="_blank" rel="noopener noreferrer" className="text-brand hover:underline break-all">
                      {s.title || s.url}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p className="text-[9px] text-fg-subtle">Проверь поля и нажми Save.</p>
        </div>
      )}
    </div>
  );
}
