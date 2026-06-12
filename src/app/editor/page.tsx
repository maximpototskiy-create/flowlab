// src/app/editor/page.tsx
// Browser-based timeline editor (MVP). Loads the user's recent assets for the
// bin and renders the client editor. The editor engine (@diffusionstudio/core)
// is WebCodecs-based and browser-only, so it's imported lazily inside the
// client component (never during SSR).
import { requireUser } from "@/lib/auth";
import TopNav from "@/components/TopNav";
import { queryAssets } from "@/lib/assetsQuery";
import VideoEditor, { type EditorAsset } from "@/components/editor/VideoEditor";

export const dynamic = "force-dynamic";

export default async function EditorPage({ searchParams }: { searchParams: Promise<{ wf?: string; proj?: string }> }) {
  await requireUser();
  const { wf, proj } = await searchParams;
  const { assets } = await queryAssets({ limit: 120 });
  const bin: EditorAsset[] = assets
    .filter((a) => a.kind === "video" || a.kind === "image" || a.kind === "audio")
    .map((a) => ({
      id: a.id,
      url: a.cdnUrl,
      kind: a.kind as "video" | "image" | "audio",
      label: a.prompt || a.kind,
      duration: a.durationSec ?? null,
    }));

  return (
    <div className="h-screen overflow-hidden bg-bg flex flex-col">
      <TopNav activeNav="editor" />
      <VideoEditor assets={bin} workflowId={wf} projectId={proj} />
    </div>
  );
}
