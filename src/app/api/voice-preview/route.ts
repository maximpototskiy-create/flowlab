// GET /api/voice-preview?voice=<name>
// Generates a short ElevenLabs TTS sample for the given voice via fal and
// returns the audio URL. Uses the cheapest TTS model + a short fixed sentence
// to keep the cost tiny (~$0.001). Clients cache the returned URL per voice
// (localStorage) so a voice is only ever generated once per browser.
import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { falRun } from "@/lib/fal/client";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const SAMPLE_TEXT = "Hi, this is how I sound for your voiceover.";

export async function GET(req: Request): Promise<NextResponse> {
  await requireUser();
  const { searchParams } = new URL(req.url);
  const voice = (searchParams.get("voice") ?? "").trim();
  if (!voice) return NextResponse.json({ error: "voice required" }, { status: 400 });

  try {
    const r = await falRun("fal-ai/elevenlabs/tts/turbo-v2.5", {
      text: SAMPLE_TEXT,
      voice,
      stability: 0.5,
    });
    const url = ((r.audio as { url: string } | undefined)?.url) ?? (r.audio_url as string | undefined);
    if (!url) return NextResponse.json({ error: "no audio returned" }, { status: 502 });
    return NextResponse.json({ url });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
