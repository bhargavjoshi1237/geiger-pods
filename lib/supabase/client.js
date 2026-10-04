import { createBrowserClient } from "@supabase/ssr";
import { suiteCookieOptions } from "../workspace/model.mjs";

export function isSupabaseConfigured() {
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
}

export function createClient() {
  if (!isSupabaseConfigured()) return null;
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      db: { schema: "pods" },
      cookieOptions: suiteCookieOptions(process.env.NEXT_PUBLIC_COOKIE_DOMAIN, process.env.NODE_ENV === "production"),
    },
  );
}
