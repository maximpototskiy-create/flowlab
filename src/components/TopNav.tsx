// Server component — fetches the current user itself.
import Link from "next/link";
import LogoutButton from "./LogoutButton";
import ThemeToggle from "./ThemeToggle";
import ActiveRunsIndicator from "./ActiveRunsIndicator";
import { requireUser } from "@/lib/auth";

export type Crumb = { label: string; href?: string };

export default async function TopNav({
  crumbs = [],
  activeNav,
}: {
  crumbs?: Crumb[];
  activeNav?: "dashboard" | "brands" | "projects" | "assets" | "templates" | "admin";
} = {}) {
  const user = await requireUser();

  return (
    <header className="border-b border-border sticky top-0 z-40 bg-bg/80 backdrop-blur">
      <div className="max-w-7xl mx-auto px-6 lg:px-10 h-14 flex items-center justify-between">
        <div className="flex items-center gap-7 min-w-0">
          <Link href="/dashboard" className="font-medium text-[15px] leading-none whitespace-nowrap">
            Flow<em className="text-brand not-italic">Lab</em>
          </Link>
          <nav className="hidden md:flex items-center gap-5 text-[11px] uppercase tracking-wider font-medium">
            <NavLink href="/dashboard" active={activeNav === "dashboard"}>
              Dashboard
            </NavLink>
            <NavLink href="/brands" active={activeNav === "brands"}>
              Brands
            </NavLink>
            <NavLink href="/projects" active={activeNav === "projects"}>
              Projects
            </NavLink>
            <NavLink href="/assets" active={activeNav === "assets"}>
              Assets
            </NavLink>
            {user.role === "admin" && (
              <NavLink href="/admin" active={activeNav === "admin"}>
                Admin
              </NavLink>
            )}
            <span className="text-fg-subtle cursor-not-allowed" title="Coming soon">
              Templates
            </span>
          </nav>
        </div>
        <div className="flex items-center gap-3">
          <ActiveRunsIndicator />
          <span className="hidden md:flex items-center gap-2 text-[11px] text-fg-muted max-w-[200px] truncate">
            <span className="w-1.5 h-1.5 rounded-full bg-brand animate-pulse" />
            <span className="truncate">{user.email}</span>
          </span>
          <ThemeToggle />
          <LogoutButton />
        </div>
      </div>

      {crumbs.length > 0 && (
        <div className="max-w-7xl mx-auto px-6 lg:px-10 h-9 flex items-center gap-2 text-[11px] uppercase tracking-wider text-fg-muted border-t border-border/60">
          {crumbs.map((c, i) => (
            <span key={i} className="flex items-center gap-2">
              {i > 0 && <span className="text-fg-subtle">/</span>}
              {c.href ? (
                <Link href={c.href} className="hover:text-fg transition">
                  {c.label}
                </Link>
              ) : (
                <span className="text-fg">{c.label}</span>
              )}
            </span>
          ))}
        </div>
      )}
    </header>
  );
}

function NavLink({ href, active, children }: { href: string; active?: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className={active ? "text-fg" : "text-fg-muted hover:text-fg transition"}
    >
      {children}
    </Link>
  );
}
