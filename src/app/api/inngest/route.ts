import { serve } from "inngest/next";
import { inngest } from "@/lib/inngest/client";
import { runWorkflowFn } from "@/lib/inngest/functions";

// Inngest reaches this endpoint to run queued functions. maxDuration is set
// high because a workflow run can take minutes (multiple AI/video nodes).
export const maxDuration = 800;

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [runWorkflowFn],
});
