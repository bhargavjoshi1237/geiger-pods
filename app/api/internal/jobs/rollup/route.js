import { cronDb } from "../cron.mjs";
import { runRollup } from "@/lib/control/retention.mjs";
import { jsonResponse, errorResponse } from "@/lib/control/http.mjs";

export const runtime = "nodejs";

// Vercel Cron → POST /api/internal/jobs/rollup (every hour): minute rows
// older than the current hour roll up to metrics_hour (kept 455 days).
export async function POST(request) {
  const guarded = await cronDb(request);
  if (guarded.response) return guarded.response;
  try {
    const summary = await runRollup(guarded.db);
    return jsonResponse(summary, guarded.requestId, 200);
  } catch (error) {
    return errorResponse(error, guarded.requestId);
  }
}

export async function GET(request) {
  return POST(request);
}
