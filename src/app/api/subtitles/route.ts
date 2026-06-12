// Subtitles via AssemblyAI.
//   POST /api/subtitles   { audioUrl, language? }  → { id }       (submit transcript)
//   GET  /api/subtitles?id=<id>                    → { status, words?, error? }  (poll)
// The asset is already hosted (Supabase public URL), so we pass audio_url directly
// to AssemblyAI — no separate upload step needed. API key stays server-side.
import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const AAI = "https://api.assemblyai.com/v2/transcript";

function key(): string {
  const k = process.env.ASSEMBLYAI_API_KEY;
  if (!k) throw new Error("ASSEMBLYAI_API_KEY is not set");
  return k;
}

export async function POST(req: Request): Promise<NextResponse> {
  await requireUser();
  let body: { audioUrl?: string; language?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Bad JSON" }, { status: 400 }); }
  const audioUrl = (body.audioUrl || "").trim();
  if (!/^https?:\/\//i.test(audioUrl)) return NextResponse.json({ error: "audioUrl must be a public http(s) URL" }, { status: 400 });

  const lang = (body.language || "auto").toLowerCase();
  // NOTE: the field is `speech_model` (singular). The previous `speech_models`
  // array was rejected for some inputs (e.g. wav uploads) with a 400.
  const payload: Record<string, unknown> = {
    audio_url: audioUrl,
    speech_model: "universal",
  };
  if (lang === "auto") { payload.language_detection = true; payload.language_detection_options = { fallback_language: "en" }; }
  else payload.language_code = lang;

  let apiKey: string;
  try { apiKey = key(); } catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : "config" }, { status: 500 }); }

  const r = await fetch(AAI, {
    method: "POST",
    headers: { Authorization: apiKey, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return NextResponse.json({ error: (j as { error?: string })?.error || `AssemblyAI HTTP ${r.status}` }, { status: 502 });
  return NextResponse.json({ id: j.id, status: j.status });
}

export async function GET(req: Request): Promise<NextResponse> {
  await requireUser();
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "missing id" }, { status: 400 });

  let apiKey: string;
  try { apiKey = key(); } catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : "config" }, { status: 500 }); }

  const r = await fetch(`${AAI}/${id}`, { headers: { Authorization: apiKey } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return NextResponse.json({ error: (j as { error?: string })?.error || `AssemblyAI HTTP ${r.status}` }, { status: 502 });

  if (j.status === "completed") {
    const words = Array.isArray(j.words)
      ? j.words.map((w: { text?: string; start?: number; end?: number }) => ({ text: (w.text || "").trim(), start: w.start ?? 0, end: w.end ?? 0 })).filter((w: { text: string }) => w.text)
      : [];
    return NextResponse.json({ status: "completed", words, language: j.language_code ?? null });
  }
  if (j.status === "error") return NextResponse.json({ status: "error", error: j.error || "transcription error" });
  return NextResponse.json({ status: j.status }); // queued | processing
}
