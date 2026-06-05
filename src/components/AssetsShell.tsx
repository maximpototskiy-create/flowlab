import TopNav from "@/components/TopNav";
import AssetTabs from "@/components/AssetTabs";

// Shared shell for the asset surfaces (Generated / Library / Archive).
// Identical chrome (nav, title, tabs, container width) on all three so that
// switching tabs only swaps the content below — no layout jump.
export default function AssetsShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="grain min-h-screen">
      <TopNav activeNav="assets" crumbs={[{ label: "Dashboard", href: "/dashboard" }, { label: "Assets" }]} />
      <main className="max-w-6xl mx-auto px-6 lg:px-12 py-10">
        <div className="font-mono text-xs tracking-[0.2em] uppercase text-brand mb-2">▶ Asset library</div>
        <h1 className="font-display text-4xl leading-tight mb-5">Assets</h1>
        <AssetTabs />
        {children}
      </main>
    </div>
  );
}
