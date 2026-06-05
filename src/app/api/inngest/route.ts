import { serve } from "inngest/next";
import { inngest } from "@/lib/inngest/client";
import { runWorkflowFn } from "@/lib/inngest/functions";

// Inngest reaches this endpoint to run queued functions. 300s is the Hobby
// max; on Vercel Pro this can be raised. Inngest splits and retries work, so
// a single invocation rarely needs the full window.
export const maxDuration = 300;

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [runWorkflowFn],
});
