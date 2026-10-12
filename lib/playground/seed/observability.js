// Metrics, access/execution logs, traces, alarms, notification channels and
// log sinks. Rows mirror supabase/migrations/observability. Traffic follows
// catalog.js API_SPECS[].traffic: 30 days of hourly-rollup rows (hourly for
// the last two days, 6-hour buckets before that) with a weekday shape and the
// Kestrel Aero launch ramp over the last ten days. Counters store
// sum = count like the runtime aggregator; latency rows carry 64-bucket
// histograms (lib/gateway/core/observe/metrics.mjs) so p50/p90/p99 come out
// near each API's spec.

import { PROJECT_ID, between, daysAgo, hoursAgo, minutesAgo, noise, pick, sid, weighted } from "./helpers.js";
import { personId } from "../cast.js";
import { API_SPECS, apiId, operations } from "./catalog.js";
import { STAGE_REFS } from "./releases.js";
import { HISTOGRAM_BUCKETS, bucketLowerBound, bucketUpperBound, hashDims } from "../../gateway/core/observe/metrics.mjs";

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const DAYS = 30;
const HOURLY_SPAN = 48;

// Share of a day's traffic per UTC hour (Lisbon/Brooklyn audiences: a long
// European afternoon running into the US evening).
const DIURNAL = [
  0.018, 0.014, 0.011, 0.01, 0.011, 0.016, 0.026, 0.037, 0.047, 0.053, 0.056, 0.058,
  0.06, 0.061, 0.062, 0.063, 0.063, 0.061, 0.058, 0.052, 0.045, 0.036, 0.028, 0.022,
];
const DIURNAL_TOTAL = DIURNAL.reduce((sum, value) => sum + value, 0);

// Mon..Sun multipliers by UTC weekday (0 = Sunday).
const WEEKDAY = [0.7, 1.04, 1.08, 1.06, 1.05, 1.0, 0.76];

/** Daily request rate for an API `daysBack` days ago (0 = today). */
function dailyRate(spec, daysBack, dayIndex) {
  const traffic = spec.traffic;
  if (!traffic || daysBack > spec.created) return 0;
  const weekday = WEEKDAY[new Date(Date.now() - daysBack * DAY).getUTCDay()];
  // Slow organic growth: ~8% over the month.
  const growth = 1 + (DAYS - daysBack) * 0.0027;
  let launch = 1;
  if (spec.key === "kestrel-preorders") launch = daysBack <= 10 ? 1.4 + (10 - daysBack) * 0.22 : 0.55;
  else if (spec.key === "kestrel-storefront" || spec.key === "kestrel-inventory") launch = daysBack <= 10 ? 1.1 + (10 - daysBack) * 0.035 : 1;
  const wobble = 0.9 + noise(spec.n * 1000 + dayIndex) * 0.2;
  return traffic.base * weekday * growth * launch * wobble;
}

/** Error rates by period: partner webhooks got worse this week (Shopify retries). */
function errorRates(spec, daysBack) {
  const { e4, e5 } = spec.traffic;
  if (spec.key === "partner-webhooks") return { e4, e5: daysBack <= 6 ? e5 * 1.25 : e5 * 0.7 };
  if (spec.key === "kestrel-preorders") return { e4, e5: daysBack <= 3 ? e5 * 1.3 : e5 };
  return { e4, e5 };
}

// Log-normal latency distribution over the 64 histogram buckets with p90 at
// `p90` ms: median = p90 / e^(1.2816·σ).
function latencyShape(p90, sigma = 0.55) {
  const median = p90 / Math.exp(1.2816 * sigma);
  const cdf = (ms) => {
    if (ms <= 0) return 0;
    const z = (Math.log(ms) - Math.log(median)) / sigma;
    return 0.5 * (1 + erf(z / Math.SQRT2));
  };
  const probs = [];
  for (let index = 0; index < HISTOGRAM_BUCKETS; index += 1) {
    const upper = Math.min(bucketUpperBound(index), 60000);
    probs.push(Math.max(0, cdf(upper) - cdf(bucketLowerBound(index))));
  }
  const total = probs.reduce((sum, value) => sum + value, 0) || 1;
  return { probs: probs.map((value) => value / total), mean: median * Math.exp((sigma * sigma) / 2) };
}

// Abramowitz–Stegun erf approximation (|error| < 1.5e-7).
function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496735) * t + 0.254829592) * t * Math.exp(-x * x);
  return sign * y;
}

function histogram(shape, n) {
  const hist = new Array(HISTOGRAM_BUCKETS).fill(0);
  let placed = 0;
  let top = 0;
  shape.probs.forEach((p, index) => {
    const count = Math.floor(p * n);
    hist[index] = count;
    placed += count;
    if (p > shape.probs[top]) top = index;
  });
  hist[top] += n - placed;
  return hist;
}

function histBounds(hist) {
  const first = hist.findIndex((count) => count > 0);
  let last = -1;
  hist.forEach((count, index) => { if (count > 0) last = index; });
  if (first < 0) return { min: null, max: null };
  return { min: Math.round(bucketLowerBound(first) * 10) / 10, max: Math.round(Math.min(bucketUpperBound(last), 60000) * 10) / 10 };
}

/** Bucket start times: hourly for the last 48 h (current hour partial), then 6 h. */
function buckets(nowMs) {
  const hourStart = Math.floor(nowMs / HOUR) * HOUR;
  const out = [];
  for (let i = 0; i < HOURLY_SPAN; i += 1) {
    const start = hourStart - i * HOUR;
    const fraction = i === 0 ? Math.max(0.05, (nowMs - hourStart) / HOUR) : 1;
    out.push({ start, hours: [new Date(start).getUTCHours()], fraction });
  }
  const sixStart = Math.floor((hourStart - HOURLY_SPAN * HOUR) / (6 * HOUR)) * 6 * HOUR;
  for (let start = sixStart; start > nowMs - DAYS * DAY; start -= 6 * HOUR) {
    // The first 6 h bucket may overlap the hourly span; keep only hours before it.
    const hours = [];
    for (let h = 0; h < 6; h += 1) {
      if (start + h * HOUR < hourStart - (HOURLY_SPAN - 1) * HOUR) hours.push(new Date(start + h * HOUR).getUTCHours());
    }
    if (hours.length) out.push({ start, hours, fraction: 1 });
  }
  return out;
}

function metricRow(spec, stage, start, metric, { sum, count, min = 1, max = 1, hist = null }) {
  const dims = { ApiId: spec.publicId, Stage: stage };
  return {
    project_id: PROJECT_ID,
    api_id: apiId(spec.n),
    stage,
    dims_hash: hashDims(dims),
    dims,
    hour: new Date(start).toISOString(),
    metric,
    sum,
    count,
    min: count > 0 ? min : null,
    max: count > 0 ? max : null,
    hist: hist ?? [],
  };
}

function metricsForBucket(spec, stage, bucket, requests, rates, shapes, seed) {
  const rows = [];
  const start = bucket.start;
  const n = Math.max(0, Math.round(requests));
  if (n === 0) return rows;
  const errors4 = Math.round(n * rates.e4 * (0.75 + noise(seed + 1) * 0.5));
  const errors5 = Math.round(n * rates.e5 * (0.7 + noise(seed + 2) * 0.6));
  const throttled = Math.round(n * (spec.key === "kestrel-preorders" ? 0.012 : 0.0025) * (0.5 + noise(seed + 3)));
  const counter = (metric, value) => (value > 0 ? rows.push(metricRow(spec, stage, start, metric, { sum: value, count: value })) : null);
  const latency = (metric, shape, samples) => {
    if (samples <= 0) return;
    const hist = histogram(shape, samples);
    const { min, max } = histBounds(hist);
    rows.push(metricRow(spec, stage, start, metric, { sum: Math.round(shape.mean * samples), count: samples, min, max, hist }));
  };

  if (spec.protocol === "WEBSOCKET") {
    const connects = Math.round(n * 0.14);
    counter("ConnectCount", connects);
    counter("MessageCount", n - connects);
    counter("ClientError", errors4);
    counter("ExecutionError", errors5);
    counter("IntegrationError", Math.round(errors5 * 0.6));
    latency("IntegrationLatency", shapes.integration, n - connects);
  } else {
    counter("Count", n);
    counter(spec.protocol === "HTTP" ? "4xx" : "4XXError", errors4);
    counter(spec.protocol === "HTTP" ? "5xx" : "5XXError", errors5);
    latency("Latency", shapes.latency, n);
    latency("IntegrationLatency", shapes.integration, n);
    if (spec.protocol === "HTTP") {
      const bytes = n * between(seed + 4, 1800, 4200);
      rows.push(metricRow(spec, stage, start, "DataProcessed", { sum: bytes, count: n, min: 180, max: 96000 }));
    }
    if (spec.protocol === "REST" && spec.traffic.cache > 0) {
      const lookups = Math.round(n * 0.58);
      const hits = Math.round(lookups * spec.traffic.cache * (0.92 + noise(seed + 5) * 0.16));
      counter("CacheHitCount", Math.min(lookups, hits));
      counter("CacheMissCount", Math.max(0, lookups - hits));
    }
  }
  counter("ThrottleCount", throttled);
  return rows;
}

function metricsSeed(nowMs) {
  const metrics_hour = [];
  const all = buckets(nowMs);
  for (const spec of API_SPECS) {
    if (!spec.traffic) continue;
    const shapes = {
      latency: latencyShape(spec.traffic.p90),
      integration: latencyShape(spec.traffic.p90 * 0.78, 0.6),
    };
    const stages = STAGE_REFS.filter((ref) => ref.apiN === spec.n);
    all.forEach((bucket, index) => {
      const daysBack = Math.floor((nowMs - bucket.start) / DAY);
      const dayIndex = Math.floor(bucket.start / DAY);
      const rate = dailyRate(spec, daysBack, dayIndex);
      if (rate === 0) return;
      const share = bucket.hours.reduce((sum, hour) => sum + DIURNAL[hour], 0) / DIURNAL_TOTAL;
      const requests = rate * share * bucket.fraction;
      const rates = errorRates(spec, daysBack);
      for (const stage of stages) {
        // Non-production stages carry QA traffic only: ~1.5% of prod, noisier errors.
        const volume = stage.production ? requests : requests * 0.015;
        const stageRates = stage.production ? rates : { e4: rates.e4 * 2.2, e5: rates.e5 * 1.5 };
        metrics_hour.push(...metricsForBucket(spec, stage.name, bucket, volume, stageRates, shapes, spec.n * 100000 + stage.n * 10000 + index));
      }
    });
  }
  return metrics_hour;
}

// --- Access / execution logs + traces ---------------------------------------

const SOURCE_IPS = [
  "203.0.113.24", "203.0.113.87", "198.51.100.14", "198.51.100.203", "192.0.2.61", "192.0.2.144",
  "185.199.110.42", "77.54.12.198", "94.63.201.17", "151.101.65.9", "84.91.3.120", "212.18.44.6",
];

const USER_AGENTS = [
  "KestrelDealer/4.2 (iOS 18.1)", "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) Safari/605.1.15", "AtlasApp/7.9.1 (Android 15)",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/129.0", "Shopify-Captain-Hook", "Stripe/1.0 (+https://stripe.com/docs/webhooks)",
  "node-fetch/3.3 (halcyon-ops)", "SolaceWeb/2026.10",
];

/** Deterministic UUID-shaped request id. */
export function requestIdFor(n) {
  const hex = (seed, length) => between(seed, 0, 0xffffffff).toString(16).padStart(8, "0").slice(0, length);
  return `${hex(n * 7 + 1, 8)}-${hex(n * 7 + 2, 4)}-4${hex(n * 7 + 3, 3)}-a${hex(n * 7 + 4, 3)}-${hex(n * 7 + 5, 8)}${hex(n * 7 + 6, 4)}`;
}

function concretePath(path, n) {
  return path
    .replace("{productId}", pick(["aero-7", "terra-x", "volt-city", "kids-14"], n))
    .replace("{cartId}", `c_${between(n, 10000, 99999)}`)
    .replace("{itemId}", String(between(n + 1, 1, 40)))
    .replace("{dealerId}", pick(["ams-centraal", "lis-baixa", "nyc-soho"], n))
    .replace("{orderId}", `o_${between(n + 2, 100000, 999999)}`)
    .replace("{preorderId}", `pre_${between(n + 3, 1000, 9999)}`)
    .replace("{memberId}", `m_${between(n + 4, 10000, 99999)}`)
    .replace("{hotelId}", pick(["sol-barcelona", "sol-sitges", "sol-mallorca", "sol-lisboa"], n))
    .replace("{reservationId}", `R${between(n + 5, 100000, 999999)}`)
    .replace("{storeId}", pick(["chiado", "principe-real", "alfama", "porto-ribeira"], n))
    .replace("{projectId}", pick(["kestrel-launch", "atlas-rebrand", "solace-summer"], n))
    .replace("{personId}", String(between(n + 6, 1, 12)))
    .replace("{assetId}", `as_${between(n + 7, 1000, 9999)}`)
    .replace("{size}", pick(["640w", "1280w", "2560w"], n));
}

function logsSeed() {
  const access_logs = [];
  const execution_logs = [];
  const trace_spans = [];
  const ops = operations();
  const active = API_SPECS.filter((spec) => spec.traffic);
  const weights = active.map((spec) => [spec, spec.traffic.base]);
  const TOTAL = 320;
  let execN = 0;
  let spanN = 0;

  for (let i = 1; i <= TOTAL; i += 1) {
    const spec = weighted(i * 3, weights);
    const stage = STAGE_REFS.find((ref) => ref.apiN === spec.n && ref.production);
    const apiOps = ops.filter((op) => op.spec.n === spec.n);
    const op = pick(apiOps, i * 5);
    // Denser recently: minutes ago grows quadratically over ~3 days.
    const minutes = Math.round(((i / TOTAL) ** 1.6) * 4300 + noise(i) * 9);
    const ts = minutesAgo(minutes);
    const { e4, e5 } = errorRates(spec, Math.floor(minutes / 1440));
    const roll = noise(i * 11);
    const status = roll < e5 * 3 ? weighted(i, [[502, 5], [504, 3], [500, 2]])
      : roll < (e5 * 3 + e4 * 2.5) ? weighted(i + 1, [[400, 3], [401, 2], [403, 2], [404, 3], [429, 2]])
        : op.method === "POST" ? 201 : op.method === "DELETE" ? 204 : 200;
    const latency = Math.round(spec.traffic.p90 * (0.25 + noise(i * 13) * 0.95) * (status >= 500 ? 3.5 : 1));
    const requestId = requestIdFor(i);
    const ip = pick(SOURCE_IPS, i * 17);
    const ws = spec.protocol === "WEBSOCKET";
    const method = ws ? "MESSAGE" : op.method === "ANY" ? "POST" : op.method;
    const path = ws ? op.key : op.path === "$default" ? "/webhooks/klaviyo/retry" : concretePath(op.path, i);
    access_logs.push({
      id: sid("access_log", i),
      project_id: PROJECT_ID,
      api_id: apiId(spec.n),
      stage: stage.name,
      ts,
      request_id: requestId,
      status,
      route: op.key,
      source_ip: ip,
      line: `${requestId} ${ip} ${method} ${path} ${status} ${latency}`,
      fields: {
        requestId, ip, httpMethod: method, resourcePath: ws ? op.key : op.path, path, status,
        responseLatency: latency, protocol: spec.protocol === "HTTP" ? "HTTP/2.0" : "HTTP/1.1",
        userAgent: pick(USER_AGENTS, i * 19), apiId: spec.publicId,
      },
      created_at: ts,
    });

    // Execution logs (REST/WebSocket) for errors, slow calls and a sample of the rest.
    const executionLogged = (spec.protocol !== "HTTP") && (status >= 400 || latency > spec.traffic.p90 * 0.9 || i % 6 === 0);
    if (executionLogged) {
      execN += 1;
      const integrationMs = Math.max(1, Math.round(latency * 0.8));
      const backend = `${spec.backend}${ws ? `/ws/${op.key.replace("$", "")}` : path}`;
      const lines = [
        `Extended Request Id: ${requestId.slice(0, 8).toUpperCase()}=`,
        ...(op.method !== "GET" && spec.n !== 7 ? [`Verifying Usage Plan for request: ${requestId}. API Key: ****${pick(["7f3a", "c21e", "90bd", "4e8f"], i)}`] : []),
        ...(spec.n === 7 || (spec.n === 4 && op.method !== "GET") ? [`Authorizer result: status=${status === 401 || status === 403 ? 401 : 200}, latency=${between(i, 4, 38)} ms`] : []),
        ...(spec.traffic.cache && op.method === "GET" ? [noise(i * 23) < spec.traffic.cache ? "Cache hit for the request" : "Cache miss for the request"] : []),
        `Method request path: ${JSON.stringify({ resourcePath: ws ? op.key : op.path })}`,
        `Method request headers: {accept=application/json, user-agent=${pick(USER_AGENTS, i * 19)}, x-api-key=****}`,
        `Endpoint request URI: ${backend}`,
        `Sending request to ${backend}`,
        `Received response. Status: ${status}, Integration latency: ${integrationMs} ms`,
        "Method response headers: {content-type=application/json, x-request-id=" + requestId + "}",
      ].map((message, index) => ({ level: "INFO", message, ts: new Date(Date.parse(ts) + index).toISOString() }));
      if (status >= 500) {
        lines.splice(lines.length - 1, 0, {
          level: "ERROR",
          message: status === 504 ? `Execution failed due to a timeout error: ${spec.backend} did not respond within ${spec.n === 6 ? 15000 : 29000} ms` : `Execution failed: upstream returned ${status}`,
          ts: new Date(Date.parse(ts) + 8).toISOString(),
        });
      }
      lines.push({ level: "INFO", message: "Successfully completed execution", ts: new Date(Date.parse(ts) + 12).toISOString() });
      execution_logs.push({
        id: sid("execution_log", execN),
        project_id: PROJECT_ID,
        api_id: apiId(spec.n),
        stage: stage.name,
        request_id: requestId,
        ts,
        level: status >= 500 ? "ERROR" : "INFO",
        lines,
        data_trace: false,
        created_at: ts,
      });
    }

    // Traces: REST production stages have tracing on; sample ~1 in 4.
    if (spec.protocol === "REST" && i % 4 === 0) {
      const traceId = `1-${between(i, 0x10000000, 0x6fffffff).toString(16)}-${requestId.replace(/-/g, "").slice(0, 24)}`;
      const startMs = Date.parse(ts);
      const authMs = spec.n === 7 || spec.n === 4 ? between(i + 1, 4, 30) : 0;
      const integrationMs = Math.max(1, Math.round(latency * 0.8));
      const spans = [
        { name: `${spec.publicId}/${stage.name}`, kind: "server", start: 0, duration: latency, parent: null },
        ...(authMs ? [{ name: "authorizer", kind: "internal", start: 1, duration: authMs, parent: 0 }] : []),
        { name: `integration ${op.method} ${op.path}`, kind: "client", start: 1 + authMs, duration: integrationMs, parent: 0 },
        { name: "response mapping", kind: "internal", start: 1 + authMs + integrationMs, duration: Math.max(1, latency - integrationMs - authMs - 1), parent: 0 },
      ];
      const ids = spans.map(() => between((spanN += 1) * 29, 0x10000000, 0xffffffff).toString(16).padStart(16, "0").slice(0, 16));
      spans.forEach((span, index) => {
        trace_spans.push({
          id: sid("trace_span", spanN - spans.length + index + 1),
          project_id: PROJECT_ID,
          api_id: apiId(spec.n),
          stage: stage.name,
          request_id: requestId,
          trace_id: traceId,
          span_id: ids[index],
          parent_id: span.parent === null ? null : ids[span.parent],
          name: span.name,
          kind: span.kind,
          attributes: { "http.method": op.method, "http.route": op.path, "http.status_code": status },
          start_ms: startMs + span.start,
          end_ms: startMs + span.start + span.duration,
          duration_ms: span.duration,
          status: status >= 500 && span.kind !== "internal" ? "error" : "ok",
          created_at: ts,
        });
      });
    }
  }
  return { access_logs, execution_logs, trace_spans };
}

// --- Alarms, channels, sinks --------------------------------------------------

const CHANNELS = [
  { n: 1, name: "#platform-alerts", type: "slack_webhook", config: { url: "https://hooks.slack.com/services/T0HALCYON/B07PLATFORM/xxxxxxxxxxxxxxxx" }, created: 300, by: 2 },
  { n: 2, name: "On-call (PagerDuty)", type: "webhook", config: { url: "https://events.pagerduty.com/integration/halcyon-pods/enqueue" }, created: 280, by: 9 },
  { n: 3, name: "Kestrel launch room", type: "slack_webhook", config: { url: "https://hooks.slack.com/services/T0HALCYON/B09KESTREL/xxxxxxxxxxxxxxxx" }, created: 40, by: 6 },
  { n: 4, name: "Ops digest", type: "email", config: { to: "ops@halcyon.studio" }, created: 200, by: 2 },
];

const channel = (n) => sid("notification_channel", n);

// [n, name, description, metric, apiN, statistic, period, evals, points, comparison, threshold, state, reason, created, actions]
const ALARMS = [
  [1, "Partner Webhooks 5XX", "Server errors on the Shopify/Stripe/Klaviyo fan-out.", "5xx", 9, "Sum", 300, 3, 2, ">", 25, "ALARM", "Threshold crossed: 2 of 3 datapoints [41.0, 38.0] were > 25.0.", 180, [1, 2]],
  [2, "Storefront checkout p90 latency", "Checkout should stay snappy during the Aero launch.", "Latency", 1, "p90", 300, 5, 3, ">", 400, "OK", "Threshold not crossed: 0 of 5 datapoints were > 400.0.", 150, [1, 3]],
  [3, "Aero pre-orders throttling", "Deposits hitting the stage throttle.", "ThrottleCount", 2, "Sum", 300, 3, 3, ">", 50, "INSUFFICIENT_DATA", "Insufficient data: ThrottleCount is not reported for this stage yet.", 12, [3]],
  [4, "Aero pre-orders 5XX", "Deposit failures are lost revenue.", "5xx", 2, "Sum", 60, 5, 3, ">", 15, "OK", "Threshold not crossed: 1 of 5 datapoints were > 15.0.", 38, [2, 3]],
  [5, "Atlas ordering 4XX spike", "Usually a bad app release.", "4XXError", 4, "Sum", 300, 3, 2, ">", 300, "OK", "Threshold not crossed: 0 of 3 datapoints were > 300.0.", 200, [1]],
  [6, "Solace bookings 5XX", "Raised after the PMS timeout incident.", "5XXError", 6, "Sum", 300, 3, 2, ">", 20, "OK", "Threshold not crossed after the rollback: 0 of 3 datapoints were > 20.0.", 60, [1, 2]],
  [7, "Live inventory execution errors", "Dealer screens go stale when this fires.", "ExecutionError", 3, "Sum", 300, 3, 2, ">", 30, "OK", "Threshold not crossed: 0 of 3 datapoints were > 30.0.", 120, [3]],
  [8, "Studio ops availability", "Internal tools reachable through the Lisbon connector.", "5XXError", 7, "Sum", 900, 4, 4, ">=", 5, "OK", "Threshold not crossed: 0 of 4 datapoints were >= 5.0.", 240, [4]],
  [9, "Storefront cache hit ratio", "Cache misses spike when a deploy flushes the cluster.", "CacheMissCount", 1, "Sum", 3600, 2, 2, ">", 9000, "INSUFFICIENT_DATA", "Insufficient data: alarm was just re-enabled.", 5, [1]],
];

function alarmsSeed() {
  const notification_channels = CHANNELS.map((c) => ({
    id: channel(c.n),
    project_id: PROJECT_ID,
    name: c.name,
    type: c.type,
    config: c.config,
    created_by: personId(c.by),
    created_at: daysAgo(c.created),
  }));

  const alarms = [];
  const alarm_history = [];
  let historyN = 0;
  for (const [n, name, description, metric, apiN, statistic, period, evals, points, comparison, threshold, state, reason, created, actions] of ALARMS) {
    const spec = API_SPECS.find((entry) => entry.n === apiN);
    const stage = STAGE_REFS.find((ref) => ref.apiN === apiN && ref.production);
    const id = sid("alarm", n);
    // Transitions, oldest first, ending in the current state.
    const path = state === "ALARM"
      ? [["INSUFFICIENT_DATA", "OK", 170], ["OK", "ALARM", 21], ["ALARM", "OK", 20], ["OK", "ALARM", 9], ["ALARM", "OK", 8.5], ["OK", "ALARM", 0.06]]
      : state === "OK"
        ? (n % 2 === 0
          ? [["INSUFFICIENT_DATA", "OK", created - 0.02], ["OK", "ALARM", Math.min(created - 1, 14)], ["ALARM", "OK", Math.min(created - 1, 14) - 0.1]]
          : [["INSUFFICIENT_DATA", "OK", created - 0.02]])
        : [];
    for (const [from, to, ago] of path.filter(([, , ago]) => ago < created)) {
      historyN += 1;
      const at = daysAgo(0, ago * 24);
      alarm_history.push({
        id: sid("alarm_history", historyN),
        alarm_id: id,
        project_id: PROJECT_ID,
        from_state: from,
        to_state: to,
        reason: to === "ALARM"
          ? `Threshold crossed: ${points} of ${evals} datapoints were ${comparison} ${threshold}.`
          : to === "OK" ? `Threshold not crossed: datapoints back under ${threshold}.` : "Insufficient data.",
        idempotency_key: `${id}:${at}`,
        created_at: at,
      });
    }
    const lastAt = alarm_history.filter((row) => row.alarm_id === id).at(-1)?.created_at ?? daysAgo(created);
    alarms.push({
      id,
      project_id: PROJECT_ID,
      name,
      description,
      metric,
      dimensions: { ApiId: spec.publicId, Stage: stage.name },
      statistic,
      period_sec: period,
      evaluation_periods: evals,
      datapoints_to_alarm: points,
      comparison,
      threshold,
      treat_missing_data: n === 3 || n === 9 ? "missing" : "notBreaching",
      actions: { ok: actions.slice(0, 1).map(channel), alarm: actions.map(channel), insufficientData: [] },
      state,
      state_reason: reason,
      state_updated_at: lastAt,
      enabled: true,
      version: 1 + (n % 3),
      created_by: personId(pick([2, 9, 5, 4], n)),
      created_at: daysAgo(created),
      updated_at: daysAgo(Math.max(0, Math.min(created, 4 + n))),
    });
  }

  const log_sinks = [
    {
      id: sid("log_sink", 1), project_id: PROJECT_ID, name: "datadog-eu", type: "https",
      config: { url: "https://http-intake.logs.datadoghq.eu/api/v2/logs", secretRef: `secret:${sid("secret", 3)}@2`, batchMaxBytes: 1048576 },
      status: "active", last_delivery_at: minutesAgo(1), last_error: null, created_by: personId(9), created_at: daysAgo(210),
    },
    {
      id: sid("log_sink", 2), project_id: PROJECT_ID, name: "access-log-archive", type: "s3",
      config: { bucket: "halcyon-pods-logs", prefix: "access/", region: "eu-west-1", credentialsRef: `secret:${sid("secret", 4)}@1` },
      status: "active", last_delivery_at: minutesAgo(4), last_error: null, created_by: personId(2), created_at: daysAgo(300),
    },
    {
      id: sid("log_sink", 3), project_id: PROJECT_ID, name: "grafana-otlp", type: "otlp_logs",
      config: { endpoint: "https://otlp-gateway-prod-eu-west-2.grafana.net/otlp/v1/logs", headersRef: `secret:${sid("secret", 5)}@1` },
      status: "error", last_delivery_at: hoursAgo(26), last_error: "401 Unauthorized: the OTLP token was rotated in Grafana Cloud.", created_by: personId(5), created_at: daysAgo(45),
    },
  ];

  const sampling_rules = [
    { id: sid("sampling_rule", 1), project_id: PROJECT_ID, priority: 1, reservoir_per_sec: 2, fixed_rate: 0.25, match: { apiId: "kstrlshop1", path: "/checkout" }, created_at: daysAgo(90) },
    { id: sid("sampling_rule", 2), project_id: PROJECT_ID, priority: 10, reservoir_per_sec: 1, fixed_rate: 0.05, match: {}, created_at: daysAgo(300) },
  ];

  return { notification_channels, alarms, alarm_history, log_sinks, sampling_rules };
}

export function observabilitySeed() {
  return {
    metrics_hour: metricsSeed(Date.now()),
    ...logsSeed(),
    ...alarmsSeed(),
  };
}
