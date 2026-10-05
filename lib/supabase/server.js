// Server-side Supabase clients (S02 §4). This module never runs in the
// browser: `server-only` is not installed in this repo, so the runtime guard
// below throws when `window` exists instead.

if (typeof window !== "undefined") {
  throw new Error("lib/supabase/server.js is server-only and cannot run in the browser.");
}

import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { suiteCookieOptions } from "../workspace/model.mjs";

function supabaseEnv() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error("Supabase is not configured (NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY).");
  }
  return { url, anonKey };
}

/**
 * Per-request client that acts as the signed-in user (RLS enforced). Uses
 * `await cookies()` per the Next 16 API and the suite cookie options shared
 * with the browser client.
 */
export async function createServerSupabase() {
  const { url, anonKey } = supabaseEnv();
  const cookieStore = await cookies();
  return createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        } catch {
          // setAll from a Server Component is a no-op (middleware refreshes).
        }
      },
    },
    cookieOptions: suiteCookieOptions(
      process.env.NEXT_PUBLIC_COOKIE_DOMAIN,
      process.env.NODE_ENV === "production",
    ),
  });
}

/**
 * Service-role client for the server vault path and jobs only. It bypasses
 * RLS, so route handlers acting for a user must never use it except through
 * the vault envelope methods after an explicit permission check.
 */
export function createServiceSupabase() {
  const { url } = supabaseEnv();
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set (server only).");
  }
  return createClient(url, serviceKey, { auth: { persistSession: false } });
}
