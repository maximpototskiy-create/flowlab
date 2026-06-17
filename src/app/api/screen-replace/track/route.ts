// POST /api/screen-replace/track { source } — returns the per-frame auto-tracked
// screen quads for a green-screen source video, so the editor can DRAW the track
// and let the user keyframe corrections (drag the points) instead of typing JSON.
//
// It reuses compositeGreenScreen with a tiny throwaway content image and the
// `captureTrack` out-param, so the track matches EXACTLY what a real render uses.
// (The composite output is discarded.) The tracking is the dominant cost, so this
// is not instant on long clips — keep source clips short for the interactive pass;
// a tracking-only fast path can be split out later.
import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { compositeGreenScreen } from "@/lib/video";
import sharp from "sharp";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request): Promise<NextResponse> {
  await requireUser();
  let body: { source?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }
  const source = (body.source || "").trim();
  if (!source) return NextResponse.json({ error: "source (video url) required" }, { status: 400 });

  let srcBuf: Buffer;
  try {
    const r = await fetch(source);
    if (!r.ok) return NextResponse.json({ error: `Could not fetch source (${r.status})` }, { status: 502 });
    srcBuf = Buffer.from(await r.arrayBuffer());
  } catch (e) {
    return NextResponse.json({ error: `Fetch failed: ${e instanceof Error ? e.message : "error"}` }, { status: 502 });
  }

  // Tiny throwaway content — only the track is wanted.
  const tiny = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 255, g: 255, b: 255 } } }).png().toBuffer();
  const track: { fps?: number; w?: number; h?: number; quads?: number[][][] } = {};
  try {
    await compositeGreenScreen({ source: srcBuf, content: tiny, contentIsVideo: false, fit: "fill", captureTrack: track });
  } catch (e) {
    return NextResponse.json({ error: `Tracking failed: ${e instanceof Error ? e.message : "error"}` }, { status: 500 });
  }
  if (!track.quads || !track.quads.length) {
    return NextResponse.json({ error: "No screen track found — is this a green-screen clip?" }, { status: 422 });
  }
  return NextResponse.json({ fps: track.fps, w: track.w, h: track.h, frames: track.quads.length, quads: track.quads });
}
