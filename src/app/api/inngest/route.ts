import { serve } from "inngest/next";
import { inngest } from "@/lib/inngest/client";
import { runWorkflowFn } from "@/lib/inngest/functions";

// Inngest reaches this endpoint to run queued functions. On Vercel Pro with
// Fluid Compute the per-invocation budget can go up to ~800s; 600 gives long
// HeyGen Avatar IV renders (polled up to 9 min) room to finish inside one
// invocation. If a deploy ever rejects this value, the plan does not allow it
// — lower back to 300.
// Vercel Pro + Fluid Compute allows up to 800s - long HeyGen renders and
// multi-node runs get full headroom (was 600).
export const maxDuration = 800;

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
