import { Inngest } from "inngest";

// Single Inngest client for FlowLab. Event keys / signing keys are read from
// env (INNGEST_EVENT_KEY, INNGEST_SIGNING_KEY) automatically in production.
export const inngest = new Inngest({ id: "flowlab" });

// Event names (typed-ish) used across the app.
export const EVENTS = {
  workflowRunRequested: "workflow/run.requested",
} as const;
