import { notFound } from "next/navigation";
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import { saveBrandKit, autofillBrandKitFromAppStore } from "@/lib/actions";
import AppStoreAutofillButton from "@/components/AppStoreAutofillButton";
import TopNav from "@/components/TopNav";
import BrandKitScreenshots from "@/components/BrandKitScreenshots";
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
              <Section title="App Store URL" description="Вставь ссылку и нажми «Подтянуть» — заполнит описание, скриншоты и иконку.">
                <input
                  name="appStoreUrl"
                  defaultValue={kit?.appStoreUrl ?? ""}
                  placeholder="https://apps.apple.com/app/id…"
                  className="w-full bg-bg border border-border rounded-md p-2.5 text-[12px] font-mono text-fg outline-none focus:border-brand"
                />
                <AppStoreAutofillButton formAction={autofillBrandKitFromAppStore} />
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
              title="UI screenshots"
              description="Upload app screenshots / store hero images / icon. Available as references in any workflow under this brand."
            >
              <BrandKitScreenshots key={kit?.uiScreenshots ?? "empty"} initialValue={kit?.uiScreenshots ?? ""} />
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
            <button
              type="submit"
              className="px-5 py-2 bg-fg text-bg rounded-md text-[12px] font-medium hover:opacity-90"
            >
              Save Brand Kit
            </button>
          </div>
        </form>
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
