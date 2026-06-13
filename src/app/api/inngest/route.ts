import { serve } from "inngest/next";
import { inngest } from "@/lib/inngest/client";
import { runWorkflowFn } from "@/lib/inngest/functions";

// Inngest reaches this endpoint to run queued functions. 300s is the Hobby
// max; on Vercel Pro this can be raised. Inngest splits and retries work, so
// a single invocation rarely needs the full window.
export const maxDuration = 300;

// CRITICAL: pin the served host to the STABLE production alias in production.
// Vercel's auto-detected URL (VERCEL_URL) is always deployment-specific
// (e.g. flowlab-<hash>.vercel.app). Inngest then registers THAT frozen
// deployment and keeps invoking it forever, so newly deployed node types
// (e.g. "subtitles") fail with "Unknown node type" even though prod is
// up to date. Reporting the stable alias makes Inngest always hit the
// latest production deployment. Override via INNGEST_SERVE_HOST if the
// production domain ever changes. Preview deployments keep their own URL.
const serveHost =
  process.env.INNGEST_SERVE_HOST ||
  (process.env.VERCEL_ENV === "production" ? "https://creative-lab-flow.vercel.app" : undefined);

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [runWorkflowFn],
  ...(serveHost ? { serveHost } : {}),
});
