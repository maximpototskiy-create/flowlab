// Instant-paint loading state for the projects dashboard, so navigating back
// from a heavy workflow renders immediately.
export default function Loading() {
  return (
    <div className="min-h-screen bg-bg px-8 py-10">
      <div className="w-40 h-8 rounded bg-bg-subtle animate-pulse mb-8" />
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="h-40 rounded-sm border border-border bg-bg-subtle/40 animate-pulse" />
        ))}
      </div>
    </div>
  );
}
