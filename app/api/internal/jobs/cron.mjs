import { createControlDb } from "@/lib/control/supabase-db.mjs";
import { withObservabilityTables } from "@/lib/control/observe-db.mjs";
import { newRequestId, errorResponse, jsonResponse } from "@/lib/control/http.mjs";

/**
 * Guards an internal job route with CRON_SECRET (Vercel Cron sends
 * `Authorization: Bearer <CRON_SECRET>`). Returns `{ db }` on success or a
 * 401/503 `Response` on failure.
 */
export async function cronDb(request) {
  const requestId = newRequestId();
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return { response: jsonResponse({ error: { code: "cron_not_configured", message: "CRON_SECRET is not set." } }, requestId, 503) };
  }
  const bearer = (request.headers.get("authorization") ?? "").match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? "";
  if (bearer !== expected) {
    return { response: jsonResponse({ error: { code: "unauthenticated", message: "Invalid cron secret." } }, requestId, 401) };
  }
  try {
    const { createServiceSupabase } = await import("@/lib/supabase/server.js");
    const service = createServiceSupabase();
    const db = withObservabilityTables(createControlDb(service, { service }), service);
    return { db, requestId };
  } catch (error) {
    return { response: errorResponse(error, requestId) };
  }
}
