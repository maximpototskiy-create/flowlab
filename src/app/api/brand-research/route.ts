// POST /api/brand-research — deep brand research using the agent router.
// Two stages: (1) Gemini + Google Search investigates the brand live and
// returns sources; (2) OpenAI structures the findings into brand-kit fields.
// Fills empty fields only (voice / lexicon), returns a summary + sources.
import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { callAgent } from "@/lib/agent/router";
import { revalidatePath } from "next/cache";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request): Promise<NextResponse> {
  await requireUser();
  let body: { brandId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Bad request" }, { status: 400 });
  }
  const brandId = body.brandId;
  if (!brandId) return NextResponse.json({ ok: false, error: "brandId required" }, { status: 400 });

  const brand = await prisma.brand.findUnique({ where: { id: brandId } });
  const kit = await prisma.brandKit.findUnique({ where: { brandId } });
  if (!brand) return NextResponse.json({ ok: false, error: "Brand not found" }, { status: 404 });

  const subject = [brand.name, kit?.productPitch, kit?.appStoreUrl].filter(Boolean).join(" — ");
  if (!subject.trim()) {
    return NextResponse.json(
      { ok: false, error: "Нечего исследовать: добавь название, питч или ссылку App Store." },
      { status: 400 },
    );
  }

  try {
    // Stage 1 — live research with web search (Gemini grounding).
    const research = await callAgent({
      task: "research",
      webSearch: true,
      user: `Исследуй бренд/приложение и собери фактуру из открытых источников.
Объект: ${subject}
${kit?.appStoreUrl ? `App Store: ${kit.appStoreUrl}` : ""}

Опиши по-русски и по делу:
1) Tone of voice (как бренд говорит с аудиторией).
2) Целевая аудитория.
3) 3–5 реальных конкурентов.
4) Ключевые слова и фразы, характерные для бренда.
5) Темы и слова, которых бренду стоит избегать.
Опирайся на реальные данные из поиска.`,
    });

    // Stage 2 — structure into brand-kit fields (OpenAI JSON).
    const structured = await callAgent({
      task: "generate",
      json: true,
      system: "Ты возвращаешь СТРОГО валидный JSON без markdown и пояснений.",
      user: `На основе этого ресёрча верни JSON по схеме:
{
  "voice": "1-2 предложения о tone of voice",
  "audience": "краткое описание аудитории",
  "lexiconAllow": "ключевые слова через запятую",
  "lexiconAvoid": "слова/темы избегать через запятую",
  "competitors": ["конкурент 1", "конкурент 2"],
  "summary": "2-3 предложения резюме о бренде"
}

Ресёрч:
${research.text}`,
    });

    let parsed: {
      voice?: string;
      audience?: string;
      lexiconAllow?: string;
      lexiconAvoid?: string;
      competitors?: string[];
      summary?: string;
    } = {};
    try {
      parsed = JSON.parse(structured.text);
    } catch {
      // If structuring failed, still return the raw research text.
      return NextResponse.json({
        ok: true,
        found: { summary: research.text.slice(0, 600) },
        sources: research.sources ?? [],
        note: "Не удалось структурировать — показан сырой ресёрч.",
      });
    }

    // Fill only empty fields (don't overwrite the user's work).
    const data: Record<string, string> = {};
    if (parsed.voice && !kit?.voice) data.voice = parsed.voice;
    if (parsed.lexiconAllow && !kit?.lexiconAllow) data.lexiconAllow = parsed.lexiconAllow;
    if (parsed.lexiconAvoid && !kit?.lexiconAvoid) data.lexiconAvoid = parsed.lexiconAvoid;

    if (Object.keys(data).length > 0) {
      await prisma.brandKit.upsert({
        where: { brandId },
        create: { brandId, ...data },
        update: data,
      });
    }
    revalidatePathSafe(brand.slug);

    return NextResponse.json({
      ok: true,
      filled: Object.keys(data),
      found: {
        voice: parsed.voice ?? "",
        audience: parsed.audience ?? "",
        competitors: parsed.competitors ?? [],
        summary: parsed.summary ?? "",
      },
      sources: research.sources ?? [],
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Research failed";
    console.error("[api/brand-research] failed:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

function revalidatePathSafe(slug: string) {
  try {
    revalidatePath(`/brands/${slug}/brand-kit`);
  } catch {
    /* ignore */
  }
}
