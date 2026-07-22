// src/app/login/page.tsx
"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">(
    "idle"
  );
  const [error, setError] = useState("");
  // Resend cooldown: Supabase rate-limits auth emails PROJECT-WIDE, so rapid
  // retries from several people burn the shared budget. The countdown stops
  // pointless resends and gives the limit window time to pass.
  const [cooldown, setCooldown] = useState(0);

  function startCooldown(sec: number) {
    setCooldown(sec);
    const t = setInterval(() => {
      setCooldown((c) => {
        if (c <= 1) { clearInterval(t); return 0; }
        return c - 1;
      });
    }, 1000);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (cooldown > 0) return;
    setStatus("sending");
    setError("");

    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim().toLowerCase(),
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback`,
      },
    });

    if (error) {
      setStatus("error");
      const isRate = /rate limit/i.test(error.message);
      setError(
        isRate
          ? "Sign-in emails are rate-limited right now (several teammates signing in at once). Wait a minute and try again - your previous link may still arrive and stays valid."
          : error.message,
      );
      if (isRate) startCooldown(60);
    } else {
      setStatus("sent");
      startCooldown(30);
    }
  }

  return (
    <div className="grain min-h-screen flex">
      {/* Left rail — brand identity */}
      <aside className="hidden md:flex flex-col justify-between w-[44%] lg:w-[40%] border-r border-border p-12">
        <div className="space-y-2">
          <div className="font-mono text-xs tracking-[0.2em] text-fg-muted uppercase">
            v0.1 — Internal Tool
          </div>
          <h1 className="font-display text-[64px] leading-none">
            Flow<em className="text-brand not-italic">Lab</em>
          </h1>
        </div>

        <div className="space-y-8">
          <p className="font-display text-2xl italic text-fg-muted leading-snug max-w-md">
            A node-based playground for AI-generated motion creatives.
            <br />
            Built for the team, not for the demo.
          </p>

          <div className="grid grid-cols-2 gap-x-8 gap-y-4 max-w-md font-mono text-[11px] tracking-wide uppercase text-fg-subtle">
            <div>
              <div className="text-fg-muted">Generative</div>
              <div className="mt-1">Image · Video · Voice</div>
            </div>
            <div>
              <div className="text-fg-muted">Structural</div>
              <div className="mt-1">Hook · Body · Pack Shot</div>
            </div>
            <div>
              <div className="text-fg-muted">Export</div>
              <div className="mt-1">After Effects · Direct</div>
            </div>
            <div>
              <div className="text-fg-muted">Models</div>
              <div className="mt-1">Latest fal.ai roster</div>
            </div>
          </div>
        </div>

        <div className="font-mono text-[10px] tracking-wider uppercase text-fg-subtle">
          {new Date().getFullYear()} — Part of Creative Lab
        </div>
      </aside>

      {/* Right — auth form */}
      <main className="flex-1 flex flex-col justify-center px-8 md:px-16 lg:px-24 py-12">
        {/* Mobile brand */}
        <div className="md:hidden mb-12">
          <h1 className="font-display text-5xl leading-none">
            Flow<em className="text-brand not-italic">Lab</em>
          </h1>
        </div>

        <div className="max-w-sm w-full mx-auto md:mx-0">
          {status === "sent" ? (
            <div className="animate-fade-up">
              <div className="font-mono text-xs tracking-[0.2em] uppercase text-brand mb-6">
                ▶ Link sent
              </div>
              <h2 className="font-display text-4xl leading-tight mb-4">
                Check your inbox.
              </h2>
              <p className="text-fg-muted leading-relaxed mb-2">
                We sent a sign-in link to
              </p>
              <p className="font-mono text-sm bg-bg-subtle border border-border-strong rounded px-3 py-2 mb-6 break-all">
                {email}
              </p>
              <p className="text-fg-muted text-sm leading-relaxed">
                Click the link in the email to sign in. The link expires in 1 hour.
              </p>
              <button
                onClick={() => {
                  setStatus("idle");
                  setEmail("");
                }}
                className="mt-6 font-mono text-xs tracking-wider uppercase text-fg-muted hover:text-fg transition"
              >
                ← Use a different email
              </button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="animate-fade-up">
              <div className="font-mono text-xs tracking-[0.2em] uppercase text-fg-muted mb-6">
                Sign in
              </div>
              <h2 className="font-display text-4xl leading-tight mb-2">
                Welcome.
              </h2>
              <p className="text-fg-muted leading-relaxed mb-10">
                Enter your work email. We&apos;ll send a magic link — no password
                needed.
              </p>

              <div className="space-y-5">
                <div>
                  <label
                    htmlFor="email"
                    className="block font-mono text-[10px] tracking-[0.15em] uppercase text-fg-muted mb-2"
                  >
                    Email
                  </label>
                  <input
                    id="email"
                    type="email"
                    autoComplete="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    disabled={status === "sending"}
                    placeholder="you@company.com"
                    className="w-full bg-transparent border-b border-border-strong px-0 py-3 text-lg outline-none focus:border-brand transition placeholder:text-fg-subtle disabled:opacity-50"
                  />
                </div>

                <button
                  type="submit"
                  disabled={status === "sending" || !email || cooldown > 0}
                  className="group w-full flex items-center justify-between bg-brand text-black font-mono text-xs tracking-[0.15em] uppercase py-4 px-5 rounded-sm hover:bg-emerald-400 disabled:opacity-50 disabled:cursor-not-allowed transition"
                >
                  <span>
                    {status === "sending" ? "Sending link…" : cooldown > 0 ? `Wait ${cooldown}s to resend` : "Send magic link"}
                  </span>
                  <span className="group-hover:translate-x-1 transition-transform">
                    →
                  </span>
                </button>

                {error && (
                  <div className="font-mono text-xs text-red-400 bg-red-500/5 border border-red-500/20 rounded px-3 py-2">
                    {error}
                  </div>
                )}
              </div>

              <p className="mt-10 text-xs text-fg-subtle leading-relaxed">
                By signing in, you agree to be a part of the FlowLab team.
                No account creation, no passwords. Access by invitation only —
                ask your team lead if you can&apos;t get in.
              </p>
            </form>
          )}
        </div>
      </main>
    </div>
  );
}
