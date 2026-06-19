import { NextResponse } from "next/server";
import { listAvatars, listVoices, type HeyGenAvatar, type HeyGenVoice } from "@/lib/heygen/client";

// Avatars/voices barely change — cache in module memory for 10 minutes so
// opening several HeyGen nodes doesn't hammer the API (and survives within
// a warm serverless instance). Listing avatars paginates (up to 8 pages) +
// voices; on a slow HeyGen response the old 60s cap could time out and return
// a non-JSON platform error page, so give it Pro's full ceiling.
export const maxDuration = 300;

// Avatars/voices barely change — cache in module memory for 10 minutes so
// opening several HeyGen nodes doesn't hammer the API (and survives within
// a warm serverless instance).
let cache: { at: number; avatars: HeyGenAvatar[]; voices: HeyGenVoice[] } | null = null;
const TTL = 10 * 60 * 1000;

export async function GET() {
  try {
    if (cache && Date.now() - cache.at < TTL) {
      return NextResponse.json({ avatars: cache.avatars, voices: cache.voices, cached: true });
    }
    const [avatars, voices] = await Promise.all([listAvatars(), listVoices()]);
    cache = { at: Date.now(), avatars, voices };
    return NextResponse.json({ avatars, voices });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "heygen options failed" }, { status: 500 });
  }
}
