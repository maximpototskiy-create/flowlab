// Instant-paint loading state for the workflow canvas route. Without it the
// whole navigation waits for the server render of a (potentially huge) graph,
// the UI freezes, and rapid re-clicks used to pile up concurrent renders.
export default function Loading() {
  return (
    <div className="h-screen w-full flex flex-col bg-bg">
      <div className="h-12 border-b border-border flex items-center gap-3 px-4">
        <div className="w-24 h-4 rounded bg-bg-subtle animate-pulse" />
        <div className="w-40 h-4 rounded bg-bg-subtle animate-pulse" />
        <div className="ml-auto w-20 h-7 rounded-md bg-bg-subtle animate-pulse" />
      </div>
      <div className="flex-1 grid place-items-center">
        <div className="flex flex-col items-center gap-3 text-fg-subtle text-sm">
          <div className="w-8 h-8 rounded-full border-2 border-border border-t-brand animate-spin" />
          Loading workflow...
        </div>
      </div>
    </div>
  );
}
