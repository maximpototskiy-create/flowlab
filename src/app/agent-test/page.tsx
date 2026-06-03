"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";

// Simple playground to verify the agent router + both providers + web search.
// Visit /agent-test after deploy.
export default function AgentTestPage() {
  const [task, setTask] = useState<"research" | "generate" | "chat">("research");
  const [user, setUser] = useState("Кратко: что за приложение MyScreen - Live Wallpapers и кто его конкуренты?");
  const [webSearch, setWebSearch] = useState(true);
  const [loading, setLoading] = useState(false);
  const [out, setOut] = useState<{ text: string; provider?: string; model?: string; sources?: { url: string; title?: string }[]; error?: string } | null>(null);

  async function run() {
    setLoading(true);
    setOut(null);
    try {
      const res = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task, user, webSearch }),
      });
      const data = await res.json();
      setOut(data);
    } catch {
      setOut({ text: "", error: "Network error" });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="max-w-2xl mx-auto p-6 space-y-4">
      <h1 className="text-lg font-semibold text-fg">Agent router — тест</h1>
      <p className="text-[12px] text-fg-muted">
        Проверка LLM-роутера. research → Gemini (с веб-поиском), generate → OpenAI, chat → Gemini.
      </p>

      <div className="flex gap-2 items-center">
        <select
          value={task}
          onChange={(e) => setTask(e.target.value as "research" | "generate" | "chat")}
          className="bg-bg border border-border rounded-md p-2 text-[12px] text-fg"
        >
          <option value="research">research (Gemini + web)</option>
          <option value="generate">generate (OpenAI)</option>
          <option value="chat">chat (Gemini)</option>
        </select>
        <label className="flex items-center gap-1.5 text-[12px] text-fg-muted">
          <input type="checkbox" checked={webSearch} onChange={(e) => setWebSearch(e.target.checked)} />
          web search
        </label>
      </div>

      <textarea
        value={user}
        onChange={(e) => setUser(e.target.value)}
        rows={3}
        className="w-full bg-bg border border-border rounded-md p-2.5 text-[12px] text-fg outline-none focus:border-brand"
      />

      <button
        onClick={run}
        disabled={loading}
        className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-brand text-black font-medium text-[12px] disabled:opacity-60"
      >
        {loading && <Loader2 size={13} className="animate-spin" />}
        {loading ? "Думаю…" : "Отправить"}
      </button>

      {out && (
        <div className="border border-border rounded-md p-3 space-y-2">
          {out.error ? (
            <p className="text-red-400 text-[12px]">Ошибка: {out.error}</p>
          ) : (
            <>
              <div className="text-[10px] text-fg-subtle uppercase tracking-wider">
                {out.provider} · {out.model}
              </div>
              <p className="text-[13px] text-fg whitespace-pre-wrap">{out.text}</p>
              {out.sources && out.sources.length > 0 && (
                <div className="pt-2 border-t border-border">
                  <div className="text-[10px] text-fg-subtle uppercase tracking-wider mb-1">Источники</div>
                  <ul className="space-y-0.5">
                    {out.sources.map((s, i) => (
                      <li key={i} className="text-[11px]">
                        <a href={s.url} target="_blank" rel="noopener noreferrer" className="text-brand hover:underline">
                          {s.title || s.url}
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
