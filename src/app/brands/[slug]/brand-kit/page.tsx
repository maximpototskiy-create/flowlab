import { notFound } from "next/navigation";
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import { saveBrandKit } from "@/lib/actions";
import BrandMagicButton from "@/components/BrandMagicButton";
import BrandAssetsManager from "@/components/BrandAssetsManager";
import SaveBrandKitButton from "@/components/SaveBrandKitButton";
import TopNav from "@/components/TopNav";
import { ChevronLeft } from "lucide-react";

export default async function BrandKitPage({ params }: { params: Promise<{ slug: string }> }) {
  await requireUser();
  const { slug } = await params;

  const brand = await prisma.brand.findUnique({
    where: { slug },
    include: { brandKit: true },
  });
  if (!brand) notFound();

  const kit = brand.brandKit;

  return (
    <div className="min-h-screen bg-bg text-fg">
      <TopNav />
      <main className="max-w-3xl mx-auto px-6 py-8">
        <div className="mb-6">
          <Link
            href={`/brands/${slug}`}
            className="inline-flex items-center gap-1.5 text-[12px] text-fg-muted hover:text-fg mb-3"
          >
            <ChevronLeft size={12} />
            Back to {brand.name}
          </Link>
          <h1 className="text-2xl font-medium text-fg">Brand Kit</h1>
          <p className="text-[13px] text-fg-muted mt-1">
            Define {brand.name}&apos;s identity & product context. Auto-injected
            into every LLM call inside this brand&apos;s workflows.
          </p>
        </div>

        <div className="rounded-lg border border-brand/40 bg-brand/5 p-4 mb-5">
          <BrandMagicButton brandId={brand.id} />
        </div>

        <form action={saveBrandKit} className="space-y-6">
          <input type="hidden" name="brandId" value={brand.id} />

          {/* ─────────────────────────────────────── Product context (NEW) */}
          <div className="rounded-lg border border-border bg-bg-card p-5 space-y-5">
            <div>
              <h2 className="text-[14px] font-medium text-fg">Product context</h2>
              <p className="text-[11px] text-fg-muted mt-0.5">
                What is this app? Used in every generation to keep the LLM
                grounded in the actual product.
              </p>
            </div>

            <Section
              title="Product pitch"
              description="One or two sentences: what this app does and for whom."
            >
              <textarea
                name="productPitch"
                defaultValue={kit?.productPitch ?? ""}
                placeholder="A privacy-first password manager for families. Syncs across devices without ever uploading vault data to a third-party server."
                rows={3}
                className="w-full bg-bg border border-border rounded-md p-3 text-[12px] text-fg outline-none focus:border-brand resize-y"
              />
            </Section>

            <div className="grid md:grid-cols-2 gap-4">
              <Section title="App Store URL" description="Auto-filled by the magic button; or paste a link.">
                <input
                  name="appStoreUrl"
                  defaultValue={kit?.appStoreUrl ?? ""}
                  placeholder="https://apps.apple.com/app/id…"
                  className="w-full bg-bg border border-border rounded-md p-2.5 text-[12px] font-mono text-fg outline-none focus:border-brand"
                />
              </Section>
              <Section title="Google Play URL" description="Optional, just a link.">
                <input
                  name="googlePlayUrl"
                  defaultValue={kit?.googlePlayUrl ?? ""}
                  placeholder="https://play.google.com/store/apps/details?id=…"
                  className="w-full bg-bg border border-border rounded-md p-2.5 text-[12px] font-mono text-fg outline-none focus:border-brand"
                />
              </Section>
            </div>

            <Section
              title="App icon"
              description="Brand icon (auto-filled from the store). Paste a URL to override."
            >
              <div className="flex items-center gap-3">
                {brand.iconUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={brand.iconUrl} alt="" className="w-14 h-14 rounded-xl border border-border object-cover flex-shrink-0" />
                ) : (
                  <div className="w-14 h-14 rounded-xl border border-dashed border-border flex items-center justify-center text-[9px] text-fg-subtle flex-shrink-0">
                    no icon
                  </div>
                )}
                <input
                  name="iconUrl"
                  defaultValue={brand.iconUrl ?? ""}
                  placeholder="https://…/icon.png"
                  className="flex-1 bg-bg border border-border rounded-md p-2.5 text-[12px] font-mono text-fg outline-none focus:border-brand"
                />
              </div>
            </Section>
          </div>

          {/* ─────────────────────────────────────── Voice & lexicon */}
          <div className="rounded-lg border border-border bg-bg-card p-5 space-y-5">
            <div>
              <h2 className="text-[14px] font-medium text-fg">Voice & lexicon</h2>
              <p className="text-[11px] text-fg-muted mt-0.5">
                How the brand speaks.
              </p>
            </div>

            <Section
              title="Tone of voice"
              description="Describe how the brand speaks. Used by all LLM nodes."
            >
              <textarea
                name="voice"
                defaultValue={kit?.voice ?? ""}
                placeholder="Friendly, witty, no jargon. Speaks like a smart friend who happens to know about productivity."
                rows={4}
                className="w-full bg-bg border border-border rounded-md p-3 text-[12px] text-fg outline-none focus:border-brand resize-y"
              />
            </Section>

            <Section
              title="Voice clone IDs (ElevenLabs)"
              description="Comma-separated ElevenLabs voice IDs that match the brand."
            >
              <input
                name="voiceCloneIds"
                defaultValue={kit?.voiceCloneIds ?? ""}
                placeholder="e.g. ElevenLabs voice IDs"
                className="w-full bg-bg border border-border rounded-md p-2.5 text-[12px] font-mono text-fg outline-none focus:border-brand"
              />
            </Section>

            <div className="grid md:grid-cols-2 gap-4">
              <Section title="Words to prefer" description="Phrases that fit the brand.">
                <textarea
                  name="lexiconAllow"
                  defaultValue={kit?.lexiconAllow ?? ""}
                  placeholder="effortless, lightweight, focused"
                  rows={4}
                  className="w-full bg-bg border border-border rounded-md p-3 text-[12px] text-fg outline-none focus:border-brand resize-y"
                />
              </Section>
              <Section title="Words to avoid" description="Banned terms.">
                <textarea
                  name="lexiconAvoid"
                  defaultValue={kit?.lexiconAvoid ?? ""}
                  placeholder="cheap, basic, simple"
                  rows={4}
                  className="w-full bg-bg border border-border rounded-md p-3 text-[12px] text-fg outline-none focus:border-brand resize-y"
                />
              </Section>
            </div>

            <Section
              title="Banned themes"
              description="Topics never to mention in ads (compliance, ethics, etc.)"
            >
              <textarea
                name="bannedThemes"
                defaultValue={kit?.bannedThemes ?? ""}
                placeholder="gambling, dating, weight loss claims"
                rows={3}
                className="w-full bg-bg border border-border rounded-md p-3 text-[12px] text-fg outline-none focus:border-brand resize-y"
              />
            </Section>
          </div>

          {/* ─────────────────────────────────────── Visual identity */}
          <div className="rounded-lg border border-border bg-bg-card p-5 space-y-5">
            <div>
              <h2 className="text-[14px] font-medium text-fg">Visual identity</h2>
              <p className="text-[11px] text-fg-muted mt-0.5">
                Brand-level colors and fonts for image generation prompts.
              </p>
            </div>

            <Section
              title="Brand colors"
              description="One hex code per line. e.g. #10b981"
            >
              <textarea
                name="colors"
                defaultValue={kit?.colors ?? ""}
                placeholder="#10b981&#10;#0f172a&#10;#f59e0b"
                rows={4}
                className="w-full bg-bg border border-border rounded-md p-3 text-[12px] font-mono text-fg outline-none focus:border-brand resize-y"
              />
              {kit?.colors && (
                <div className="flex gap-2 mt-2 flex-wrap">
                  {kit.colors
                    .split("\n")
                    .map((c: string) => c.trim())
                    .filter((c: string) => /^#[0-9a-f]{3,6}$/i.test(c))
                    .map((c: string) => (
                      <div
                        key={c}
                        className="w-10 h-10 rounded-md border border-border"
                        style={{ background: c }}
                        title={c}
                      />
                    ))}
                </div>
              )}
            </Section>

            <Section title="Fonts" description="Headline / body font names. One per line.">
              <textarea
                name="fonts"
                defaultValue={kit?.fonts ?? ""}
                placeholder="Inter (body)&#10;Source Serif Pro (headline)"
                rows={3}
                className="w-full bg-bg border border-border rounded-md p-3 text-[12px] text-fg outline-none focus:border-brand resize-y"
              />
            </Section>
          </div>

          <div className="flex justify-end pt-2">
            <SaveBrandKitButton />
          </div>
        </form>

        <div className="rounded-lg border border-border bg-bg-card p-5 space-y-4 mt-6">
          <div>
            <h2 className="text-[14px] font-medium text-fg">Brand assets</h2>
            <p className="text-[11px] text-fg-muted mt-0.5">
              Reusable building blocks for this brand — logos, UI, graphic elements, overlays, music, sound, references, and creative parts (hook / body / packshot). Available in workflows.
            </p>
          </div>
          <BrandAssetsManager brandId={brand.id} />
        </div>
      </main>
    </div>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <h3 className="text-[13px] font-medium text-fg mb-0.5">{title}</h3>
      <p className="text-[11px] text-fg-muted mb-2">{description}</p>
      {children}
    </div>
  );
}
