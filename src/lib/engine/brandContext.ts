// src/lib/engine/brandContext.ts
//
// buildBrandContext loads a brand's full identity + product info from DB and
// formats it as a multi-line "brand brief" that gets injected as ctx.brandVoice
// into every LLM-driven node run in that brand's workflows.
//
// The output is plain markdown-ish text. Format chosen so that:
//   • Claude / GPT / Gemini all parse it cleanly without special prompt templates
//   • The model treats it as authoritative product context (not "user input")
//   • Empty / unset fields are silently omitted (no "App Store URL: null" noise)
//
// The runner appends this string after the user's instructions, prefixed
// with "Brand voice:\n…". This is intentional — putting it AFTER the task
// instruction (rather than at the very top) means the model uses brand
// info as constraints/colour, not as the primary task definition.

import { prisma } from "@/lib/prisma";
import { resignSupabaseUrl } from "@/lib/storage";

export async function buildBrandContext(brandId: string | null): Promise<string | undefined> {
  if (!brandId) return undefined;

  const brand = await prisma.brand.findUnique({
    where: { id: brandId },
    include: { brandKit: true },
  });
  if (!brand) return undefined;

  const k = brand.brandKit;
  const parts: string[] = [];

  // Product identity — always include name + description if present.
  parts.push(`**Brand:** ${brand.name}`);
  if (brand.description) parts.push(`**About:** ${brand.description}`);

  if (k?.productPitch) {
    parts.push(`**Product pitch:** ${k.productPitch}`);
  }

  // App store presence — handy because LLMs often need to mention the app
  // by its actual store name / category.
  if (k?.appStoreUrl || k?.googlePlayUrl) {
    const links: string[] = [];
    if (k.appStoreUrl) links.push(`App Store: ${k.appStoreUrl}`);
    if (k.googlePlayUrl) links.push(`Google Play: ${k.googlePlayUrl}`);
    parts.push(`**Stores:** ${links.join(" · ")}`);
  }

  // Voice / lexicon — the original brand kit fields.
  if (k?.voice) parts.push(`**Tone of voice:** ${k.voice}`);
  if (k?.lexiconAllow) parts.push(`**Words to prefer:** ${k.lexiconAllow.replace(/\s*\n\s*/g, ", ")}`);
  if (k?.lexiconAvoid) parts.push(`**Words to avoid:** ${k.lexiconAvoid.replace(/\s*\n\s*/g, ", ")}`);
  if (k?.bannedThemes) parts.push(`**Banned themes (NEVER reference):** ${k.bannedThemes}`);

  // Visual identity — colors / fonts. Useful for image-prompt generators that
  // need to specify brand colors in their output.
  if (k?.colors) {
    const cleaned = (k.colors as string)
      .split("\n")
      .map((c: string) => c.trim())
      .filter((c: string) => c.length > 0)
      .join(", ");
    if (cleaned) parts.push(`**Brand colors:** ${cleaned}`);
  }
  if (k?.fonts) {
    const cleaned = (k.fonts as string)
      .split("\n")
      .map((f: string) => f.trim())
      .filter((f: string) => f.length > 0)
      .join(", ");
    if (cleaned) parts.push(`**Fonts:** ${cleaned}`);
  }

  return parts.join("\n");
}

/** Parse the newline-separated UI screenshot URLs from a brand's kit.
 *  Used by the "Brand Assets" node and elsewhere that needs the asset list. */
// Returns brand image asset URLs (from brand_assets — the single source).
// Optionally filter by category; default returns all visual (image) assets,
// which is what the Brand Assets canvas node and ctx injection use.
export async function getBrandUiScreenshots(
  brandId: string | null,
  category?: string,
): Promise<string[]> {
  if (!brandId) return [];
  const rows = (await prisma.brandAsset.findMany({
    where: { brandId, kind: "image", ...(category ? { category } : {}) },
    orderBy: { createdAt: "desc" },
    select: { url: true },
  })) as { url: string }[];
  const urls = rows.map((r) => r.url).filter((u) => u.startsWith("http"));
  // Fresh signed tokens: stored URLs may be weeks old and expired - models
  // that fetch refs by URL fail with cryptic 422s otherwise.
  return Promise.all(urls.map((u) => resignSupabaseUrl(u)));
}
