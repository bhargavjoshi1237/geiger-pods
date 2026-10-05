import { cronDb } from "../cron.mjs";
import { evaluateAllAlarms } from "@/lib/control/alarms.mjs";
import { jsonResponse, errorResponse } from "@/lib/control/http.mjs";

export const runtime = "nodejs";

/**
 * Sends one alarm-transition notification to a channel. `webhook` POSTs JSON;
 * `slack_webhook` POSTs a `{ text }` payload; `email` goes through the suite
 * mailer when configured and is otherwise recorded as skipped.
 */
export async function notifyChannel(channel, payload, { fetchImpl = globalThis.fetch } = {}) {
  const url = channel.config?.url ?? channel.config?.webhookUrl ?? null;
  if (channel.type === "email") {
    const mailer = process.env.PODS_MAILER_URL;
    if (!mailer) return { ok: false, skipped: "email_unavailable" };
    const response = await fetchImpl(mailer, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: channel.config?.to ?? null, subject: `Pods alarm ${payload.alarm.name}: ${payload.alarm.state}`, text: payload.reason }),
    });
    return { ok: response.ok, status: response.status };
  }
  if (!url) return { ok: false, skipped: "no_url" };
  const body = channel.type === "slack_webhook"
    ? { text: `:warning: Pods alarm *${payload.alarm.name}* → *${payload.alarm.state}* (${payload.reason})` }
    : { ...payload, channel: channel.name };
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-pods-idempotency-key": payload.idempotencyKey },
    body: JSON.stringify(body),
  });
  return { ok: response.ok, status: response.status };
}

// Vercel Cron → POST /api/internal/jobs/alarms (every minute): CloudWatch
// M-of-N evaluation over metrics_minute; transitions notify exactly once.
export async function POST(request) {
  const guarded = await cronDb(request);
  if (guarded.response) return guarded.response;
  try {
    const transitions = await evaluateAllAlarms(guarded.db, { notify: (channel, payload) => notifyChannel(channel, payload) });
    return jsonResponse({ transitions }, guarded.requestId, 200);
  } catch (error) {
    return errorResponse(error, guarded.requestId);
  }
}

export async function GET(request) {
  return POST(request);
}
