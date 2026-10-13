// Pure data shaping for the Overview dashboard: period deltas, API scoping,
// health and the attention list. Live numbers come from
// `GET /metrics?view=dashboard`; DEMO_* only feeds the landing playground.

export const DASHBOARD_DAYS = 14;

const DAY_MS = 86400 * 1000;

export function formatCount(value) {
  return Math.round(value || 0).toLocaleString("en-US");
}

export function formatLatency(ms) {
  if (ms === null || ms === undefined) return "—";
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}

export function dayLabel(iso) {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

export function errorCount(totals) {
  return (totals?.errors4xx ?? 0) + (totals?.errors5xx ?? 0);
}

/**
 * Percent change between windows. `tone` says whether the move is good for
 * the metric (`upIsGood`), separately from the arrow direction.
 */
export function periodDelta(current, previous, { upIsGood = true } = {}) {
  if (current === null || current === undefined || !(previous > 0)) return { delta: null, direction: null, tone: null };
  const pct = Math.round(((current - previous) / previous) * 100);
  const direction = pct >= 0 ? "up" : "down";
  const tone = pct === 0 ? "neutral" : (direction === "up") === upIsGood ? "good" : "bad";
  return { delta: `${pct >= 0 ? "+" : ""}${pct}%`, direction, tone };
}

export function buildStats(dashboard) {
  const current = dashboard?.current ?? {};
  const previous = dashboard?.previous ?? {};
  const days = dashboard?.days ?? DASHBOARD_DAYS;
  const footer = `vs previous ${days} days`;
  return [
    { label: "Requests", value: formatCount(current.requests), ...periodDelta(current.requests, previous.requests), footer },
    { label: "Errors", value: formatCount(errorCount(current)), ...periodDelta(errorCount(current), errorCount(previous), { upIsGood: false }), footer },
    { label: "p90 Latency", value: formatLatency(current.p90LatencyMs), ...periodDelta(current.p90LatencyMs, previous.p90LatencyMs, { upIsGood: false }), footer },
    { label: "Throttled", value: formatCount(current.throttled), ...periodDelta(current.throttled, previous.throttled, { upIsGood: false }), footer },
  ];
}

function scopedApis(dashboard, scope) {
  const wanted = new Set(scope);
  return (dashboard?.apis ?? []).filter((entry) => wanted.has(entry.apiId));
}

/** Daily series for the whole project, or summed over the APIs in `scope`. */
export function scopeDaily(dashboard, scope = []) {
  const daily = dashboard?.daily ?? [];
  if (!scope.length) return daily;
  const picked = scopedApis(dashboard, scope);
  return daily.map((cell, index) => ({
    day: cell.day,
    requests: picked.reduce((sum, entry) => sum + (entry.daily?.[index]?.requests ?? 0), 0),
    errors: picked.reduce((sum, entry) => sum + (entry.daily?.[index]?.errors ?? 0), 0),
    throttled: picked.reduce((sum, entry) => sum + (entry.daily?.[index]?.throttled ?? 0), 0),
  }));
}

/** Current-window totals for the project, or summed over the APIs in `scope`. */
export function scopeTotals(dashboard, scope = []) {
  if (!scope.length) return dashboard?.current ?? {};
  const totals = { requests: 0, errors4xx: 0, errors5xx: 0, throttled: 0, cacheHits: 0, cacheMisses: 0 };
  for (const entry of scopedApis(dashboard, scope)) {
    for (const key of Object.keys(totals)) totals[key] += entry[key] ?? 0;
  }
  return totals;
}

/** Request share by API: the top five, then everything else as "Other". */
export function trafficMix(rows) {
  const sorted = rows.filter((row) => row.requests > 0).sort((a, b) => b.requests - a.requests);
  const top = sorted.slice(0, 5).map((row) => ({ key: row.id, label: row.name, value: row.requests }));
  const rest = sorted.slice(5).reduce((sum, row) => sum + row.requests, 0);
  if (rest > 0) top.push({ key: "__other", label: "Other", value: rest });
  return top;
}

export function apiHealth({ requests = 0, errors4xx = 0, errors5xx = 0 }) {
  if (requests <= 0) return "idle";
  if (errors5xx / requests >= 0.05) return "failing";
  if (errors5xx / requests >= 0.01 || (errors4xx + errors5xx) / requests >= 0.1) return "degraded";
  return "healthy";
}

/** Joins the API list with the dashboard's per-API traffic. */
export function buildApiRows(apis = [], dashboard) {
  const traffic = new Map((dashboard?.apis ?? []).map((entry) => [entry.apiId, entry]));
  return apis.map((api) => {
    const stats = traffic.get(api.id) ?? traffic.get(api.publicId) ?? {};
    const requests = stats.requests ?? 0;
    const errors = errorCount(stats);
    return {
      id: api.id,
      ref: api.publicId ?? api.id,
      name: api.name || "Untitled API",
      protocol: api.protocol ?? "REST",
      endpointType: api.endpointType ?? "REGIONAL",
      requests,
      errors,
      errorRate: requests > 0 ? errors / requests : 0,
      p90LatencyMs: stats.p90LatencyMs ?? null,
      health: apiHealth({ requests, errors4xx: stats.errors4xx ?? 0, errors5xx: stats.errors5xx ?? 0 }),
    };
  });
}

/** Items that need someone's attention, most urgent first. */
export function buildAttention({ alarms = [], rows = [], dashboard }) {
  const firing = alarms.filter((alarm) => alarm.state === "ALARM");
  const waiting = alarms.filter((alarm) => alarm.state === "INSUFFICIENT_DATA");
  const failing = rows.filter((row) => row.health === "failing");
  const degraded = rows.filter((row) => row.health === "degraded");
  const idle = rows.filter((row) => row.health === "idle");
  const throttled = dashboard?.current?.throttled ?? 0;
  const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;
  return [
    { key: "alarms", label: "Alarms firing", hint: firing.length ? firing.slice(0, 2).map((alarm) => alarm.name).join(", ") : "Nothing firing", count: firing.length, urgency: "urgent", section: "monitoring/alarms" },
    { key: "failing", label: "Failing APIs", hint: "5% or more server errors", count: failing.length, urgency: "urgent", section: "monitoring" },
    { key: "degraded", label: "Degraded APIs", hint: "Elevated error rates", count: degraded.length, urgency: "soon", section: "monitoring" },
    { key: "throttled", label: "Throttled", hint: "Rate limits or quotas hit", count: throttled, urgency: "soon", section: "usage-plans" },
    { key: "idle", label: "Idle APIs", hint: `No traffic in the last ${plural(dashboard?.days ?? DASHBOARD_DAYS, "day")}`, count: idle.length, urgency: "routine", section: "apis" },
    { key: "waiting", label: "Awaiting data", hint: "Alarms with no datapoints yet", count: waiting.length, urgency: "routine", section: "monitoring/alarms" },
  ];
}

// --- Landing playground sample data (never shown for a real project) ---

export const DEMO_APIS = [
  { id: "demo-orders", publicId: "orders", name: "Orders API", protocol: "REST", endpointType: "REGIONAL" },
  { id: "demo-catalog", publicId: "catalog", name: "Catalog API", protocol: "HTTP", endpointType: "REGIONAL" },
  { id: "demo-checkout", publicId: "checkout", name: "Checkout", protocol: "REST", endpointType: "EDGE" },
  { id: "demo-live", publicId: "live", name: "Live Inventory", protocol: "WEBSOCKET", endpointType: "REGIONAL" },
  { id: "demo-partners", publicId: "partners", name: "Partner Webhooks", protocol: "HTTP", endpointType: "PRIVATE" },
  { id: "demo-legacy", publicId: "legacy", name: "Legacy Billing", protocol: "REST", endpointType: "REGIONAL" },
];

const DEMO_TRAFFIC = {
  "demo-orders": { base: 5200, errors4xx: 0.04, errors5xx: 0.002, p90: 84, cache: [0.62, 0.38] },
  "demo-catalog": { base: 3900, errors4xx: 0.02, errors5xx: 0.001, p90: 41, cache: [0, 0] },
  "demo-checkout": { base: 1700, errors4xx: 0.06, errors5xx: 0.018, p90: 212, cache: [0.2, 0.8] },
  "demo-live": { base: 1100, errors4xx: 0.01, errors5xx: 0.004, p90: 23, cache: [0, 0] },
  "demo-partners": { base: 420, errors4xx: 0.03, errors5xx: 0.071, p90: 640, cache: [0, 0] },
};

const DEMO_CURVE = [0.62, 0.71, 0.68, 0.8, 0.86, 0.6, 0.55, 0.78, 0.9, 0.94, 0.88, 1, 0.97, 0.74];

export function buildDemoDashboard(nowMs = Date.UTC(2026, 9, 14, 12)) {
  const fromMs = Math.floor(nowMs / DAY_MS) * DAY_MS - (DASHBOARD_DAYS - 1) * DAY_MS;
  const days = DEMO_CURVE.map((_, index) => new Date(fromMs + index * DAY_MS).toISOString());
  const apis = Object.entries(DEMO_TRAFFIC).map(([apiId, spec]) => {
    const daily = DEMO_CURVE.map((factor, index) => {
      const requests = Math.round(spec.base * factor);
      return { day: days[index], requests, errors: Math.round(requests * (spec.errors4xx + spec.errors5xx)), throttled: Math.round(requests * 0.004) };
    });
    const requests = daily.reduce((sum, cell) => sum + cell.requests, 0);
    return {
      apiId, requests, daily,
      errors4xx: Math.round(requests * spec.errors4xx),
      errors5xx: Math.round(requests * spec.errors5xx),
      throttled: daily.reduce((sum, cell) => sum + cell.throttled, 0),
      cacheHits: Math.round(requests * spec.cache[0]),
      cacheMisses: Math.round(requests * spec.cache[1]),
      p90LatencyMs: spec.p90,
    };
  });
  const sum = (key) => apis.reduce((total, entry) => total + entry[key], 0);
  const current = {
    requests: sum("requests"), errors4xx: sum("errors4xx"), errors5xx: sum("errors5xx"), throttled: sum("throttled"),
    cacheHits: sum("cacheHits"), cacheMisses: sum("cacheMisses"), p90LatencyMs: 118,
  };
  const previous = {
    requests: Math.round(current.requests * 0.86), errors4xx: Math.round(current.errors4xx * 1.1), errors5xx: Math.round(current.errors5xx * 1.3),
    throttled: Math.round(current.throttled * 0.7), cacheHits: 0, cacheMisses: 0, p90LatencyMs: 131,
  };
  const daily = days.map((day, index) => ({
    day,
    requests: apis.reduce((total, entry) => total + entry.daily[index].requests, 0),
    errors: apis.reduce((total, entry) => total + entry.daily[index].errors, 0),
    throttled: apis.reduce((total, entry) => total + entry.daily[index].throttled, 0),
  }));
  return { days: DASHBOARD_DAYS, from: days[0], to: new Date(nowMs).toISOString(), current, previous, daily, apis };
}

export const DEMO_ALARMS = [
  { id: "demo-alarm-1", name: "Partner Webhooks 5XX", state: "ALARM" },
  { id: "demo-alarm-2", name: "Checkout p90 latency", state: "OK" },
  { id: "demo-alarm-3", name: "Orders throttling", state: "INSUFFICIENT_DATA" },
];

export const DEMO_API_KEY_COUNT = 18;
