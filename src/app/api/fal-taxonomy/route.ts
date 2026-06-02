// GET /api/fal-taxonomy — lists fal Assets tags and characters across all
// keys (two accounts → merged). Used by the canvas drawer to offer
// tag-chips and character filters for the fal feed.
import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { getFalKeys } from "@/lib/fal/client";

export const dynamic = "force-dynamic";

type FalTag = { id: string; name: string; created_at: string | null };
type FalCharacter = {
  id: string;
  name: string;
  description: string | null;
  character_identifier: string | null;
  cover_image_url: string | null;
  reference_images?: string[];
};

export async function GET(): Promise<NextResponse> {
  await requireUser();
  const keys = getFalKeys();
  if (keys.length === 0) return NextResponse.json({ tags: [], characters: [] });

  async function fetchJson(path: string, key: string) {
    try {
      const res = await fetch(`https://api.fal.ai/v1/assets/${path}`, {
        headers: { Authorization: `Key ${key}` },
        cache: "no-store",
      });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  try {
    const perKey = await Promise.all(
      keys.map(async (key) => {
        const [tagsRes, charsRes] = await Promise.all([
          fetchJson("tags", key),
          fetchJson("characters", key),
        ]);
        return {
          tags: (tagsRes?.tags ?? []) as FalTag[],
          characters: (charsRes?.characters ?? []) as FalCharacter[],
        };
      }),
    );

    // Merge + dedupe by id.
    const tagMap = new Map<string, FalTag>();
    const charMap = new Map<string, FalCharacter>();
    for (const r of perKey) {
      for (const t of r.tags) if (!tagMap.has(t.id)) tagMap.set(t.id, t);
      for (const c of r.characters) if (!charMap.has(c.id)) charMap.set(c.id, c);
    }

    return NextResponse.json({
      tags: [...tagMap.values()].map((t) => ({ id: t.id, name: t.name })),
      characters: [...charMap.values()].map((c) => ({
        id: c.id,
        name: c.name,
        identifier: c.character_identifier,
        cover: c.cover_image_url,
      })),
    });
  } catch (err) {
    console.error("[api/fal-taxonomy] failed:", err);
    return NextResponse.json({ tags: [], characters: [] }, { status: 500 });
  }
}
