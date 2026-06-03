"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Sparkles } from "lucide-react";

type Found = { voice?: string; audience?: string; competitors?: string[]; summary?: string };
type Source = { url: string; title?: string };

// Deep brand research via the agent (Gemini web search + OpenAI structuring).
// Fills empty brand-kit fields and shows a summary + competitors + sources.
export default function BrandResearchButton({ brandId }: { brandId: string }) {
  const router = useRouter();
  const [status, setStatus] = useState<"idle" | "loading" | "ok" | "error">("idle");
  const [message, setMessage] = useState("");
  const [found, setFound] = useState<Found | null>(null);
  const [sources, setSources] = useState<Source[]>([]);
  const [filled, setFilled] = useState<string[]>([]);

  async function run() {
    setStatus("loading");
    setMessage("Исследую бренд в сети… это займёт 10–30 сек");
    setFound(null);
    setSources([]);
    setFilled([]);
    try {
      const res = await fetch("/api/brand-research", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brandId }),
      });
      const data = await res.json();
      if (!data.ok) {
        setStatus("error");
        setMessage(data.error || "Не получилось");
        return;
      }
      setStatus("ok");
      setMessage(data.note || "");
      setFound(data.found || null);
      setSources(data.sources || []);
      setFilled(data.filled || []);
      router.refresh();
    } catch {
      setStatus("error");
      setMessage("Сетевая ошибка");
    }
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={run}
        disabled={status === "loading"}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-brand text-brand text-[11px] hover:bg-brand/10 transition disabled:opacity-60"
      >
        {status === "loading" ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
        {status === "loading" ? "Исследую…" : "Исследовать бренд (AI)"}
      </button>

      {status === "loading" && <p className="text-[10px] text-fg-subtle">{message}</p>}
      {status === "error" && <p className="text-[10px] text-red-400">{message}</p>}

      {status === "ok" && found && (
        <div className="border border-border rounded-md p-3 space-y-2 text-[11px]">
          {filled.length > 0 && (
            <p className="text-brand text-[10px]">Заполнено автоматически: {filled.join(", ")}</p>
          )}
          {found.summary && (
            <div>
              <div className="text-[9px] uppercase tracking-wider text-fg-subtle mb-0.5">Резюме</div>
              <p className="text-fg-muted">{found.summary}</p>
            </div>
          )}
          {found.audience && (
            <div>
              <div className="text-[9px] uppercase tracking-wider text-fg-subtle mb-0.5">Аудитория</div>
              <p className="text-fg-muted">{found.audience}</p>
            </div>
          )}
          {found.competitors && found.competitors.length > 0 && (
            <div>
              <div className="text-[9px] uppercase tracking-wider text-fg-subtle mb-0.5">Конкуренты</div>
              <p className="text-fg-muted">{found.competitors.join(" · ")}</p>
            </div>
          )}
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
          <p className="text-[9px] text-fg-subtle">Поля voice/лексикон заполнены, если были пустыми. Проверь и нажми Save.</p>
        </div>
      )}
    </div>
  );
}
