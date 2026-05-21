// src/middleware.ts
// Auth middleware. Runs on every request (except static assets).
// Two jobs:
//   1. Refresh the Supabase session cookie if it's about to expire
//   2. Redirect users based on auth state:
//      - Unauthenticated user → /login (if hitting a protected route)
//      - Authenticated user → /dashboard (if hitting / or /login)

import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(
          cookiesToSet: { name: string; value: string; options?: CookieOptions }[]
        ) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;
  const isProtectedRoute =
    path.startsWith("/dashboard") ||
    path.startsWith("/projects") ||
    path.startsWith("/brands");
  const isAuthPage = path === "/login";
  const isRoot = path === "/";

  // Not logged in → forced to login for protected routes
  if (isProtectedRoute && !user) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  // Logged in → root and login pages redirect to dashboard
  if (user && (isRoot || isAuthPage)) {
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }

  return response;
}

export const config = {
  matcher: [
    // Run on everything except: static files, images, favicon
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
