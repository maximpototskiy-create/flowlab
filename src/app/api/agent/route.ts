// POST /api/agent — thin endpoint over the agent router (step 1 foundation).
// Body: { task: "research"|"generate"|"chat", user: string, system?, provider?,
//         webSearch?, json? }. Returns { text, provider, model, sources? }.
import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { callAgent, type AgentTask, type Provider } from "@/lib/agent/router";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request): Promise<NextResponse> {
  await requireUser();
  let body: {
    task?: AgentTask;
    user?: string;
    system?: string;
    provider?: Provider;
    webSearch?: boolean;
    json?: boolean;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }
  if (!body.user?.trim()) {
    return NextResponse.json({ error: "user prompt required" }, { status: 400 });
  }
  const task: AgentTask = body.task ?? "chat";

  try {
    const result = await callAgent({
      task,
      user: body.user,
      system: body.system,
      provider: body.provider,
      webSearch: body.webSearch,
      json: body.json,
    });
    return NextResponse.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Agent call failed";
    console.error("[api/agent] failed:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
