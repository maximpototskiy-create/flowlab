// src/lib/actions.ts
"use server";

import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

// ──────────────────────────────────────────────────────────────
// HELPERS
// ──────────────────────────────────────────────────────────────

const COLOR_PALETTE = [
  "emerald",
  "amber",
  "rose",
  "blue",
  "violet",
  "sky",
  "zinc",
];

function pickColor() {
  return COLOR_PALETTE[Math.floor(Math.random() * COLOR_PALETTE.length)];
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);
}

// ──────────────────────────────────────────────────────────────
// BRANDS
// ──────────────────────────────────────────────────────────────

export async function createBrand(formData: FormData) {
  const user = await requireUser();

  const name = (formData.get("name") as string)?.trim();
  const description = (formData.get("description") as string)?.trim() || null;

  if (!name) throw new Error("Brand name is required");
  if (name.length > 80) throw new Error("Brand name too long (max 80 chars)");

  // Generate slug, ensure unique
  let slug = slugify(name);
  if (!slug) slug = "brand";

  let suffix = 0;
  let finalSlug = slug;
  while (await prisma.brand.findUnique({ where: { slug: finalSlug } })) {
    suffix++;
    finalSlug = `${slug}-${suffix}`;
  }

  const brand = await prisma.brand.create({
    data: {
      name,
      slug: finalSlug,
      description,
      color: pickColor(),
      createdBy: user.id,
      brandKit: { create: {} }, // create empty brand kit
    },
  });

  revalidatePath("/brands");
  revalidatePath("/dashboard");
  redirect(`/brands/${brand.slug}`);
}

export async function renameBrand(formData: FormData) {
  await requireUser();

  const id = formData.get("id") as string;
  const name = (formData.get("name") as string)?.trim();
  const description = (formData.get("description") as string)?.trim() || null;

  if (!id || !name) throw new Error("Missing fields");
  if (name.length > 80) throw new Error("Name too long");

  await prisma.brand.update({
    where: { id },
    data: { name, description },
  });

  revalidatePath("/brands");
  revalidatePath("/dashboard");
}

export async function deleteBrand(formData: FormData) {
  await requireUser();

  const id = formData.get("id") as string;
  if (!id) throw new Error("Missing brand id");

  await prisma.brand.delete({ where: { id } });

  revalidatePath("/brands");
  revalidatePath("/dashboard");
}

// ──────────────────────────────────────────────────────────────
// PROJECTS
// ──────────────────────────────────────────────────────────────

export async function createProject(formData: FormData) {
  const user = await requireUser();

  const name = (formData.get("name") as string)?.trim();
  const description = (formData.get("description") as string)?.trim() || null;
  const brandId = (formData.get("brandId") as string) || null;

  if (!name) {
    throw new Error("Project name is required");
  }
  if (name.length > 80) {
    throw new Error("Project name is too long (max 80 chars)");
  }
  if (!brandId) {
    throw new Error("A brand is required. Create a project from the brand page.");
  }

  // Verify the brand exists
  const brand = await prisma.brand.findUnique({ where: { id: brandId } });
  if (!brand) throw new Error("Brand not found");

  const project = await prisma.project.create({
    data: {
      name,
      description,
      brandId,
      color: pickColor(),
      createdBy: user.id,
    },
  });

  revalidatePath("/projects");
  revalidatePath("/dashboard");
  revalidatePath(`/brands/${brand.slug}`);
  redirect(`/projects/${project.id}`);
}

export async function renameProject(formData: FormData) {
  await requireUser();

  const id = formData.get("id") as string;
  const name = (formData.get("name") as string)?.trim();
  const description = (formData.get("description") as string)?.trim() || null;

  if (!id || !name) throw new Error("Missing fields");
  if (name.length > 80) throw new Error("Name too long");

  await prisma.project.update({
    where: { id },
    data: { name, description },
  });

  revalidatePath("/projects");
  revalidatePath(`/projects/${id}`);
  revalidatePath("/dashboard");
}

export async function deleteProject(formData: FormData) {
  await requireUser();

  const id = formData.get("id") as string;
  if (!id) throw new Error("Missing project id");

  await prisma.project.delete({ where: { id } });

  revalidatePath("/projects");
  revalidatePath("/dashboard");
  // No server redirect — client handles navigation to avoid 404 on stale page
}

// ──────────────────────────────────────────────────────────────
// WORKFLOWS
// ──────────────────────────────────────────────────────────────

export async function createWorkflow(formData: FormData) {
  const user = await requireUser();

  const projectId = formData.get("projectId") as string;
  const name = (formData.get("name") as string)?.trim() || "Untitled workflow";

  if (!projectId) throw new Error("Missing project id");
  if (name.length > 120) throw new Error("Name too long");

  const workflow = await prisma.workflow.create({
    data: {
      projectId,
      name,
      createdBy: user.id,
    },
  });

  revalidatePath(`/projects/${projectId}`);
  revalidatePath("/dashboard");
  redirect(`/projects/${projectId}/workflows/${workflow.id}`);
}

export async function renameWorkflow(formData: FormData) {
  await requireUser();

  const id = formData.get("id") as string;
  const name = (formData.get("name") as string)?.trim();

  if (!id || !name) throw new Error("Missing fields");
  if (name.length > 120) throw new Error("Name too long");

  const wf = await prisma.workflow.update({
    where: { id },
    data: { name },
  });

  revalidatePath(`/projects/${wf.projectId}`);
  revalidatePath(`/projects/${wf.projectId}/workflows/${id}`);
}

export async function deleteWorkflow(formData: FormData) {
  await requireUser();

  const id = formData.get("id") as string;
  if (!id) throw new Error("Missing workflow id");

  const wf = await prisma.workflow.delete({ where: { id } });

  revalidatePath(`/projects/${wf.projectId}`);
  revalidatePath("/dashboard");
  // No server redirect — client handles navigation
}

export async function duplicateWorkflow(formData: FormData) {
  const user = await requireUser();

  const id = formData.get("id") as string;
  if (!id) throw new Error("Missing workflow id");

  const original = await prisma.workflow.findUnique({ where: { id } });
  if (!original) throw new Error("Workflow not found");

  const copy = await prisma.workflow.create({
    data: {
      projectId: original.projectId,
      name: `${original.name} (copy)`,
      graph: original.graph as object,
      createdBy: user.id,
    },
  });

  revalidatePath(`/projects/${original.projectId}`);
  redirect(`/projects/${original.projectId}/workflows/${copy.id}`);
}

// ──────────────────────────────────────────────────────────────
// WORKFLOW GRAPH PERSISTENCE
// ──────────────────────────────────────────────────────────────

// Save the entire graph (nodes + edges) to a workflow.
// Called by the canvas via debounced autosave (~2s after last edit).
export async function saveWorkflowGraph(workflowId: string, graph: unknown) {
  await requireUser();

  if (!workflowId) throw new Error("Missing workflowId");
  if (!graph || typeof graph !== "object") {
    throw new Error("Graph must be an object");
  }

  await prisma.workflow.update({
    where: { id: workflowId },
    data: { graph: graph as object },
  });

  // No revalidate — autosave is silent, no UI refresh needed
  return { savedAt: new Date().toISOString() };
}

// ──────────────────────────────────────────────────────────────
// BRAND KIT
// ──────────────────────────────────────────────────────────────

export async function saveBrandKit(formData: FormData): Promise<void> {
  await requireUser();
  const brandId = formData.get("brandId") as string;
  if (!brandId) throw new Error("brandId required");

  const data = {
    colors: (formData.get("colors") as string) || null,
    fonts: (formData.get("fonts") as string) || null,
    voice: (formData.get("voice") as string) || null,
    voiceCloneIds: (formData.get("voiceCloneIds") as string) || null,
    lexiconAllow: (formData.get("lexiconAllow") as string) || null,
    lexiconAvoid: (formData.get("lexiconAvoid") as string) || null,
    bannedThemes: (formData.get("bannedThemes") as string) || null,
    // Product context (step 4.11) — these are auto-injected as ctx.brandVoice
    // for every LLM node in any workflow under this brand.
    appStoreUrl: (formData.get("appStoreUrl") as string) || null,
    googlePlayUrl: (formData.get("googlePlayUrl") as string) || null,
    productPitch: (formData.get("productPitch") as string) || null,
    uiScreenshots: (formData.get("uiScreenshots") as string) || null,
  };

  await prisma.brandKit.upsert({
    where: { brandId },
    create: { brandId, ...data },
    update: data,
  });

  const brand = await prisma.brand.findUnique({ where: { id: brandId } });
  if (brand) revalidatePath(`/brands/${brand.slug}/brand-kit`);
}

// Auto-fill the brand kit from an App Store listing via the free iTunes
// Lookup API (no key needed). Pulls description → productPitch, screenshots →
// uiScreenshots, and app icon → brand.iconUrl. Non-destructive: keeps an
// existing pitch, merges screenshots, only sets the icon if missing.
export async function autofillBrandKitFromAppStore(formData: FormData): Promise<void> {
  await requireUser();
  const brandId = formData.get("brandId") as string;
  const appStoreUrl = ((formData.get("appStoreUrl") as string) || "").trim();
  if (!brandId) throw new Error("brandId required");
  if (!appStoreUrl) throw new Error("appStoreUrl required");

  // App Store URLs look like https://apps.apple.com/us/app/name/id123456789
  const m = appStoreUrl.match(/id(\d+)/);
  if (!m) throw new Error("Could not find an app id in that App Store URL");
  const appId = m[1];
  // Optional country code from the URL (…/us/app/…) improves localization.
  const countryMatch = appStoreUrl.match(/apps\.apple\.com\/([a-z]{2})\//i);
  const country = countryMatch ? countryMatch[1].toLowerCase() : "us";

  const res = await fetch(`https://itunes.apple.com/lookup?id=${appId}&country=${country}`, {
    cache: "no-store",
  });
  if (!res.ok) throw new Error("App Store lookup failed");
  const json = (await res.json()) as { results?: Array<Record<string, unknown>> };
  const app = json.results?.[0];
  if (!app) throw new Error("App not found in the App Store");

  const screenshotUrls = [
    ...((app.screenshotUrls as string[]) || []),
    ...((app.ipadScreenshotUrls as string[]) || []),
  ].filter((u) => typeof u === "string" && u.startsWith("http"));
  const icon = (app.artworkUrl512 as string) || (app.artworkUrl100 as string) || null;
  const description = (app.description as string) || "";

  const existing = await prisma.brandKit.findUnique({ where: { brandId } });
  const existingShots = (existing?.uiScreenshots || "")
    .split("\n")
    .map((s: string) => s.trim())
    .filter(Boolean);
  const mergedShots = [...new Set([...existingShots, ...screenshotUrls])];

  const data = {
    appStoreUrl,
    // Keep a pitch the user already wrote; otherwise seed from the description.
    productPitch: existing?.productPitch || description.slice(0, 800) || null,
    uiScreenshots: mergedShots.join("\n") || null,
  };
  await prisma.brandKit.upsert({
    where: { brandId },
    create: { brandId, ...data },
    update: data,
  });

  // Update the brand icon from the store artwork.
  const brand = await prisma.brand.findUnique({ where: { id: brandId } });
  if (icon && brand) {
    await prisma.brand.update({ where: { id: brandId }, data: { iconUrl: icon } }).catch(() => {});
  }
  if (brand) revalidatePath(`/brands/${brand.slug}/brand-kit`);
}
