import { cronDb } from "../cron.mjs";
import { runRetention } from "@/lib/control/retention.mjs";
import { jsonResponse, errorResponse } from "@/lib/control/http.mjs";

export const runtime = "nodejs";

// Vercel Cron → POST /api/internal/jobs/retention (daily): drops telemetry
// older than each project's retention (log partitions, minute/hour metrics,
// trace spans, opt-in audit expiry).
export async function POST(request) {
  const guarded = await cronDb(request);
  if (guarded.response) return guarded.response;
  try {
    const summary = await runRetention(guarded.db);
    return jsonResponse(summary, guarded.requestId, 200);
  } catch (error) {
    return errorResponse(error, guarded.requestId);
  }
}

export async function GET(request) {
  return POST(request);
}
