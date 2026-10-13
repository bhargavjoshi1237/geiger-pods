// Synthetic operating history so the dashboards tell a coherent story:
// 30 days of hourly-rollup metrics (hourly for the last 48 h, 6-hour buckets
// before), per-key daily usage, alarm transitions, portal analytics, webhook
// deliveries, connector heartbeats and a backdated release timeline.
//
// Story beats: the Fall 2026 season premiere (8–12 days ago) lifts traffic
// ~70%; a 3-hour AniList incident 4 days ago trips the 5XX alarm; v1.3 has
// been on a 10% prod canary since yesterday; free-tier keys keep brushing
// their daily quota (the "Quota rejections" alarm is firing right now).
//
// The current UTC hour is left empty on purpose: live gateway traffic writes
// metrics_minute rows there, and the hourly rollup must not collide with a
// seeded metrics_hour row for the same hour.

import { HISTOGRAM_BUCKETS, bucketLowerBound, bucketUpperBound, hashDims } from "../../../lib/gateway/core/observe/metrics.mjs";
import { recordHeartbeat } from "../../../lib/control/connectors.mjs";
import { listStages } from "../../../lib/control/stages.mjs";
import { items } from "../context.mjs";

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const DAYS = 30;
const HOURLY_SPAN = 48;

// Share of a day's traffic per UTC hour: anime audiences peak in the Japanese
// and US evenings (UTC 10–15 and 00–04).
const DIURNAL = [
  0.052, 0.055, 0.054, 0.05, 0.043, 0.034, 0.027, 0.024, 0.027, 0.034, 0.045, 0.052,
  0.056, 0.057, 0.053, 0.046, 0.038, 0.031, 0.027, 0.026, 0.029, 0.035, 0.042, 0.048,
];
const DIURNAL_TOTAL = DIURNAL.reduce((sum, value) => sum + value, 0);
const WEEKDAY = [1.18, 0.92, 0.9, 0.93, 0.95, 1.04, 1.22]; // Sun..Sat — weekends binge harder

function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496735) * t + 0.254829592) * t * Math.exp(-x * x);
  return sign * y;
}

/** Log-normal latency over the 64 histogram buckets with p90 at `p90` ms. */
function latencyShape(p90, sigma = 0.6) {
  const median = p90 / Math.exp(1.2816 * sigma);
  const cdf = (ms) => (ms <= 0 ? 0 : 0.5 * (1 + erf((Math.log(ms) - Math.log(median)) / sigma / Math.SQRT2)));
  const probs = [];
  for (let index = 0; index < HISTOGRAM_BUCKETS; index += 1) {
    probs.push(Math.max(0, cdf(Math.min(bucketUpperBound(index), 60000)) - cdf(bucketLowerBound(index))));
  }
  const total = probs.reduce((sum, value) => sum + value, 0) || 1;
  return { probs: probs.map((value) => value / total), mean: median * Math.exp((sigma * sigma) / 2) };
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

/** Season-premiere lift: ramps in 12 days ago, peaks ~10 days ago, settles by 7. */
function seasonLift(daysBack) {
  if (daysBack > 12.5 || daysBack < 6.5) return 1;
  const peak = 10;
  return 1 + 0.75 * Math.exp(-((daysBack - peak) ** 2) / 4.5);
}

/** The AniList incident: 4 days ago, UTC 14:00–17:00. */
function incidentAt(nowMs, startMs) {
  const incidentStart = Math.floor((nowMs - 4 * DAY) / DAY) * DAY + 14 * HOUR;
  return startMs >= incidentStart && startMs < incidentStart + 3 * HOUR;
}

function buckets(nowMs, { sixHourOnly = false, sinceMs = 0 } = {}) {
  const hourStart = Math.floor(nowMs / HOUR) * HOUR;
  const out = [];
  const hourly = sixHourOnly ? 0 : HOURLY_SPAN;
  // i = 1: skip the current (live) hour.
  for (let i = 1; i <= hourly; i += 1) {
    const start = hourStart - i * HOUR;
    if (start >= sinceMs) out.push({ start, hours: [new Date(start).getUTCHours()] });
  }
  const boundary = hourStart - hourly * HOUR; // first hour NOT covered hourly
  for (let start = Math.floor((boundary - 1) / (6 * HOUR)) * 6 * HOUR; start > nowMs - DAYS * DAY; start -= 6 * HOUR) {
    const hours = [];
    for (let h = 0; h < 6; h += 1) {
      const at = start + h * HOUR;
      if (at < boundary && at < hourStart && at >= sinceMs) hours.push(new Date(at).getUTCHours());
    }
    if (hours.length) out.push({ start, hours });
  }
  return out;
}

function trafficSpecs(state, nowMs) {
  return [
    {
      apiId: state.rest.apiId, publicId: state.rest.publicId, protocol: "REST", base: 26000, p90: 210, cache: 0.71, e4: 0.027, e5: 0.0025, sinceMs: nowMs - 33 * DAY,
      stages: [
        { name: "prod", share: 1, canaryCut: true },
        { name: "prod/Canary", share: 0.1, sinceMs: nowMs - 1.2 * DAY, e5Factor: 0.6 },
        { name: "staging", share: 0.012, sixHourOnly: true, e4Factor: 2.4 },
        { name: "dev", share: 0.006, sixHourOnly: true, e4Factor: 3.5, e5Factor: 2 },
      ],
    },
    {
      apiId: state.http.apiId, publicId: state.http.publicId, protocol: "HTTP", base: 9500, p90: 340, e4: 0.012, e5: 0.004, sinceMs: nowMs - 15 * DAY,
      stages: [{ name: "$default", share: 1 }],
    },
    {
      apiId: state.ws.apiId, publicId: state.ws.publicId, protocol: "WEBSOCKET", base: 2600, p90: 290, e4: 0.01, e5: 0.006, sinceMs: nowMs - 6 * DAY,
      stages: [{ name: "production", share: 1 }],
    },
  ];
}

function metricRows(projectId, spec, stageName, startMs, n, rates, shapes, rand, flags) {
  const rows = [];
  const dims = { ApiId: spec.publicId, Stage: stageName };
  const dimsHash = hashDims(dims);
  const row = (metric, { sum, count, min = 1, max = 1, hist = [] }) => rows.push({
    project_id: projectId, api_id: spec.apiId, stage: stageName, dims_hash: dimsHash, dims,
    hour: new Date(startMs).toISOString(), metric, sum, count, min: count > 0 ? min : null, max: count > 0 ? max : null, hist,
  });
  const counter = (metric, value) => { if (value > 0) row(metric, { sum: value, count: value }); };
  const latency = (metric, shape, samples) => {
    if (samples <= 0) return;
    const hist = histogram(shape, samples);
    const { min, max } = histBounds(hist);
    row(metric, { sum: Math.round(shape.mean * samples), count: samples, min, max, hist });
  };
  if (n <= 0) return rows;
  const e4 = Math.round(n * rates.e4 * (0.75 + rand() * 0.5));
  const e5 = Math.round(n * rates.e5 * (0.7 + rand() * 0.6));
  if (spec.protocol === "WEBSOCKET") {
    const connects = Math.round(n * 0.12);
    counter("ConnectCount", connects);
    counter("MessageCount", n - connects);
    counter("ClientError", e4);
    counter("ExecutionError", e5);
    counter("IntegrationError", Math.round(e5 * 0.7));
    latency("IntegrationLatency", shapes.integration, n - connects);
  } else {
    counter("Count", n);
    counter(spec.protocol === "HTTP" ? "4xx" : "4XXError", e4);
    counter(spec.protocol === "HTTP" ? "5xx" : "5XXError", e5);
    if (spec.protocol === "REST" && spec.cache) {
      const lookups = Math.round(n * 0.62);
      const hitRate = spec.cache * (flags.incident ? 0.55 : 1) * (flags.lift > 1.3 ? 0.82 : 1) * (0.94 + rand() * 0.1);
      const hits = Math.min(lookups, Math.round(lookups * hitRate));
      counter("CacheHitCount", hits);
      counter("CacheMissCount", lookups - hits);
      // Cached responses are fast; misses pay AniList's round trip.
      latency("Latency", hits / Math.max(1, n) > 0.4 ? shapes.latency : shapes.slow, n);
    } else {
      latency("Latency", shapes.latency, n);
    }
    latency("IntegrationLatency", flags.incident ? shapes.slow : shapes.integration, Math.round(n * (spec.cache ? 0.45 : 1)));
    if (spec.protocol === "HTTP") row("DataProcessed", { sum: n * Math.round(2400 + rand() * 1800), count: n, min: 220, max: 96000 });
  }
  counter("ThrottleCount", Math.round(n * 0.004 * flags.lift * (0.5 + rand())));
  if (spec.protocol === "REST" && stageName === "prod") counter("QuotaRejectCount", Math.round(n * 0.0022 * flags.lift * (0.4 + rand())));
  return rows;
}

export function buildMetrics(state, projectId, nowMs) {
  const out = [];
  for (const spec of trafficSpecs(state, nowMs)) {
    const shapes = {
      latency: latencyShape(spec.p90),
      slow: latencyShape(spec.p90 * 2.8, 0.7),
      integration: latencyShape(spec.p90 * 1.9, 0.6),
    };
    for (const [stageIndex, stage] of spec.stages.entries()) {
      const rand = prng(spec.base * 31 + stageIndex * 7919);
      const sinceMs = Math.max(spec.sinceMs, stage.sinceMs ?? 0);
      for (const bucket of buckets(nowMs, { sixHourOnly: stage.sixHourOnly, sinceMs })) {
        const daysBack = (nowMs - bucket.start) / DAY;
        const weekday = WEEKDAY[new Date(bucket.start).getUTCDay()];
        const growth = 1 + (DAYS - daysBack) * 0.004;
        const lift = seasonLift(daysBack);
        const share = bucket.hours.reduce((sum, hour) => sum + DIURNAL[hour], 0) / DIURNAL_TOTAL;
        let requests = spec.base * weekday * growth * lift * share * (0.92 + rand() * 0.16) * stage.share;
        // While the canary runs, prod keeps 90% of the traffic.
        const canaryLive = bucket.start >= nowMs - 1.2 * DAY;
        if (stage.canaryCut && canaryLive) requests *= 0.9;
        const incident = spec.protocol !== "WEBSOCKET" && incidentAt(nowMs, bucket.start) && bucket.hours.length === 1;
        const rates = {
          e4: spec.e4 * (stage.e4Factor ?? 1),
          e5: incident ? 0.085 : spec.e5 * (stage.e5Factor ?? 1),
        };
        out.push(...metricRows(projectId, spec, stage.name, bucket.start, Math.round(requests), rates, shapes, rand, { incident, lift }));
      }
    }
  }
  return out;
}

// --- Per-key usage --------------------------------------------------------------

const KEY_USAGE = [
  // name, plan, stage, per-day calls, [activeFromDaysAgo, activeUntilDaysAgo]
  ["Crunchy Recs ML", "partner", "prod", 9000, [33, 0]],
  ["Demo Presenter", "partner", "prod", 140, [30, 0]],
  ["Otaku Tracker iOS", "pro", "prod", 1550, [32, 0]],
  ["Seasonal Chart Web", "pro", "prod", 1100, [31, 5]],
  ["Seasonal Chart Web (rotated)", "pro", "prod", 1100, [5, 0]],
  ["Manga Reader Beta", "pro", "prod", 320, [6, 0]],
  ["Weeb Discord Bot", "free", "prod", 495, [29, 0]],
  ["Campus Anime Club", "free", "prod", 130, [6, 0]],
  ["Hackathon Team 7", "free", "prod", 360, [20, 16]],
  ["QA Smoke Tests", "qa", "staging", 290, [33, 0]],
];
const DAILY_QUOTA = { free: 500 };

function buildUsage(state, projectId, keyIds, nowMs) {
  const rows = [];
  const today = Math.floor(nowMs / DAY);
  for (const [name, plan, stage, perDay, [from, until]] of KEY_USAGE) {
    const keyId = keyIds[name];
    if (!keyId) continue;
    const rand = prng(perDay * 13 + name.length);
    for (let back = Math.min(from, DAYS); back >= Math.max(until, 1); back -= 1) {
      const dayMs = (today - back) * DAY;
      const weekday = WEEKDAY[new Date(dayMs).getUTCDay()];
      let wanted = Math.round(perDay * weekday * seasonLift(back) * (0.85 + rand() * 0.3));
      let quotaRejected = 0;
      if (DAILY_QUOTA[plan] && wanted > DAILY_QUOTA[plan]) {
        quotaRejected = wanted - DAILY_QUOTA[plan];
        wanted = DAILY_QUOTA[plan];
      }
      const throttled = Math.round(wanted * (plan === "free" ? 0.03 : 0.004) * (0.5 + rand()));
      rows.push({
        project_id: projectId, plan_id: state.plans[plan].id, api_key_id: keyId, api_id: state.rest.apiId,
        stage_name: stage, day: new Date(dayMs).toISOString().slice(0, 10), count: wanted, throttled, quota_rejected: quotaRejected,
      });
    }
  }
  return rows;
}

// --- Writers ----------------------------------------------------------------------

async function upsertChunks(supabase, table, rows, onConflict) {
  for (let index = 0; index < rows.length; index += 500) {
    const { error } = await supabase.schema("pods").from(table).upsert(rows.slice(index, index + 500), { onConflict });
    if (error) throw new Error(`${table}: ${error.message}`);
  }
}

async function update(supabase, table, match, patch) {
  let query = supabase.schema("pods").from(table).update(patch);
  for (const [key, value] of Object.entries(match)) query = query.eq(key, value);
  const { error } = await query;
  if (error) throw new Error(`${table}: ${error.message}`);
}

const ago = (nowMs, days) => new Date(nowMs - days * DAY).toISOString();

export async function seedData(ctx, state) {
  const { supabase, db, actor, projectId, log } = ctx;
  const nowMs = Date.now();
  const pods = supabase.schema("pods");

  log.section("Metrics history (30 days)");
  const metrics = buildMetrics(state, projectId, nowMs);
  await upsertChunks(supabase, "metrics_hour", metrics, "project_id,api_id,stage,dims_hash,hour,metric");
  log.item(`= ${metrics.length} metrics_hour rows across ${new Set(metrics.map((row) => `${row.api_id}:${row.stage}`)).size} api/stage series`);

  log.section("Per-key usage");
  const { data: keyRows, error: keyError } = await pods.from("api_keys").select("id, name").eq("project_id", projectId);
  if (keyError) throw new Error(keyError.message);
  const keyIds = Object.fromEntries((keyRows ?? []).map((row) => [row.name, row.id]));
  const usage = buildUsage(state, projectId, keyIds, nowMs);
  await upsertChunks(supabase, "usage_daily", usage, "project_id,plan_id,api_key_id,api_id,stage_name,day");
  log.item(`= ${usage.length} usage_daily rows for ${new Set(usage.map((row) => row.api_key_id)).size} keys`);
  for (const [name, , , , [, until]] of KEY_USAGE) {
    if (!keyIds[name]) continue;
    const lastUsed = until === 0 ? new Date(nowMs - Math.round(Math.random() * 40) * 60000).toISOString() : ago(nowMs, until);
    await update(supabase, "api_keys", { id: keyIds[name] }, { last_used_at: lastUsed });
  }

  log.section("Alarm states & history");
  // Days ago of the incident start (UTC 14:00 four calendar days back) and its recovery.
  const incident = (nowMs - (Math.floor((nowMs - 4 * DAY) / DAY) * DAY + 14 * HOUR)) / DAY;
  const recovered = incident - 3 / 24;
  const transitions = {
    "Explorer prod 5XX": { state: "OK", reason: "Threshold not crossed: 0 of 3 datapoints were > 20.0.", path: [["INSUFFICIENT_DATA", "OK", 32], ["OK", "ALARM", incident - 0.25 / 24], ["ALARM", "OK", recovered - 0.2 / 24]] },
    "Explorer prod p90 latency": { state: "OK", reason: "Threshold not crossed: 0 of 5 datapoints were > 1200.0.", path: [["INSUFFICIENT_DATA", "OK", 32], ["OK", "ALARM", incident - 0.5 / 24], ["ALARM", "OK", recovered - 0.4 / 24]] },
    "Explorer throttling": { state: "OK", reason: "Threshold not crossed: 1 of 3 datapoints were > 150.0.", path: [["INSUFFICIENT_DATA", "OK", 32], ["OK", "ALARM", 10.3], ["ALARM", "OK", 10.1]] },
    "Cache miss surge": { state: "OK", reason: "Threshold not crossed: 0 of 2 datapoints were > 1500.0.", path: [["INSUFFICIENT_DATA", "OK", 30], ["OK", "ALARM", 10.6], ["ALARM", "OK", 9.8]] },
    "Quota rejections": { state: "ALARM", reason: "Threshold crossed: 1 datapoint [64.0] was > 50.0. Free-tier keys are out of daily quota.", path: [["INSUFFICIENT_DATA", "OK", 30], ["OK", "ALARM", 10.5], ["ALARM", "OK", 9.2], ["OK", "ALARM", 0.09]] },
    "GraphQL Edge 5xx": { state: "OK", reason: "Threshold not crossed: 0 of 3 datapoints were > 10.0.", path: [["INSUFFICIENT_DATA", "OK", 14.9], ["OK", "ALARM", incident - 0.4 / 24], ["ALARM", "OK", recovered]] },
    "Live socket execution errors": { state: "INSUFFICIENT_DATA", reason: "Insufficient data: no ExecutionError datapoints in the last 3 periods.", path: [] },
  };
  for (const [name, plan] of Object.entries(transitions)) {
    const alarmId = state.alarms[name];
    if (!alarmId) continue;
    const history = plan.path.map(([from, to, daysAgo]) => {
      const at = ago(nowMs, daysAgo);
      return {
        alarm_id: alarmId, project_id: projectId, from_state: from, to_state: to,
        reason: to === "ALARM" ? `Threshold crossed (${name}).` : to === "OK" ? "Threshold not crossed: datapoints back under threshold." : "Insufficient data.",
        idempotency_key: `${alarmId}:seed:${from}->${to}:${Math.round(daysAgo * 1000)}`,
        created_at: at,
      };
    });
    if (history.length) await upsertChunks(supabase, "alarm_history", history, "idempotency_key");
    await update(supabase, "alarms", { id: alarmId }, {
      state: plan.state, state_reason: plan.reason,
      state_updated_at: history.at(-1)?.created_at ?? ago(nowMs, 0.01),
      created_at: ago(nowMs, plan.path[0]?.[2] ?? 6),
    });
  }
  log.item(`= ${Object.keys(transitions).length} alarms (1 firing: Quota rejections)`);

  log.section("Portal analytics & webhook deliveries");
  const rand = prng(42);
  const portalEvents = [];
  const productIds = Object.values(state.products ?? {});
  for (let back = 24; back >= 0; back -= 1) {
    const views = Math.round((30 + rand() * 50) * seasonLift(back));
    const tries = Math.round(views * (0.12 + rand() * 0.1));
    for (let i = 0; i < views; i += 1) {
      portalEvents.push({ portal_id: state.portal.id, product_id: productIds[i % productIds.length] ?? null, type: "page_view", created_at: new Date(nowMs - back * DAY - rand() * DAY).toISOString() });
    }
    for (let i = 0; i < tries; i += 1) {
      portalEvents.push({ portal_id: state.portal.id, product_id: productIds[(i + 1) % productIds.length] ?? null, type: "try_it", created_at: new Date(nowMs - back * DAY - rand() * DAY).toISOString() });
    }
  }
  const { count: existingEvents } = await pods.from("portal_events").select("id", { count: "exact", head: true }).eq("portal_id", state.portal.id);
  if (!existingEvents) {
    for (let index = 0; index < portalEvents.length; index += 500) {
      const { error } = await pods.from("portal_events").insert(portalEvents.slice(index, index + 500));
      if (error) throw new Error(`portal_events: ${error.message}`);
    }
    log.item(`+ ${portalEvents.length} portal events (page views + try-it)`);
  }
  await update(supabase, "portals", { id: state.portal.id }, { created_at: ago(nowMs, 25) });

  const { data: subs } = await pods.from("event_subscriptions").select("id, name, event_types").eq("project_id", projectId);
  const { count: existingDeliveries } = await pods.from("event_deliveries").select("id", { count: "exact", head: true }).eq("project_id", projectId);
  if (!existingDeliveries && subs?.length) {
    const deliveries = [];
    let n = 0;
    for (const sub of subs) {
      for (let i = 0; i < 14; i += 1) {
        n += 1;
        const at = nowMs - (i * 1.9 + rand()) * DAY;
        const failed = sub.name === "key-lifecycle-to-crm" && (i === 2 || i === 3);
        const pending = sub.name === "security-audit-feed" && i === 0;
        deliveries.push({
          project_id: projectId, subscription_id: sub.id, event_type: sub.event_types[i % sub.event_types.length],
          event_id: `evt_${(at / 1000).toFixed(0)}_${n}`,
          status: pending ? "pending" : failed ? "failed" : "delivered",
          attempts: failed ? 5 : pending ? 1 : 1 + (i % 7 === 0 ? 1 : 0),
          next_attempt_at: pending ? new Date(nowMs + 4 * 60000).toISOString() : new Date(at + 2000).toISOString(),
          last_error: failed ? "HTTP 502 from crm.geiger-notes.dev after 5 attempts" : pending ? "HTTP 503 Service Unavailable (retrying)" : null,
          created_at: new Date(at).toISOString(), updated_at: new Date(at + 2000).toISOString(),
        });
      }
    }
    const { error } = await pods.from("event_deliveries").insert(deliveries);
    if (error) throw new Error(`event_deliveries: ${error.message}`);
    log.item(`+ ${deliveries.length} webhook deliveries (2 failed, 1 retrying)`);
  }

  log.section("Connectors & release timeline");
  await recordHeartbeat(db, { connectorId: state.connectors.recs, agentCount: 2, status: "AVAILABLE", statusMessage: "2 agents connected (mumbai-rack-a, mumbai-rack-b)" }, { serviceRole: true });
  await recordHeartbeat(db, { connectorId: state.connectors.archive, agentCount: 1, status: "DEGRADED", statusMessage: "1 of 2 agents connected — archive-agent-2 last seen 03:12 UTC" }, { serviceRole: true });
  log.item("= recs-engine-mumbai AVAILABLE (2 agents), media-archive-vpc DEGRADED");

  await backdateReleases(ctx, state, nowMs);
}

async function backdateReleases(ctx, state, nowMs) {
  const { supabase, db, actor, projectId, log } = ctx;
  const pods = supabase.schema("pods");
  const [v10, v11, v12, v13] = state.rest.deployments;
  const deployedAt = [[v10, 33], [v11, 21], [v12, 9], [v13, 1.25]];
  for (const [deployment, daysAgo] of deployedAt) {
    await update(supabase, "deployments", { id: deployment.id }, { created_at: ago(nowMs, daysAgo) });
  }
  await update(supabase, "apis", { id: state.rest.apiId }, { created_at: ago(nowMs, 34) });
  await update(supabase, "apis", { id: state.http.apiId }, { created_at: ago(nowMs, 15.2) });
  await update(supabase, "deployments", { id: state.http.deployments[0].id }, { created_at: ago(nowMs, 15) });
  await update(supabase, "apis", { id: state.ws.apiId }, { created_at: ago(nowMs, 6.2) });
  await update(supabase, "deployments", { id: state.ws.deployments[0].id }, { created_at: ago(nowMs, 6) });

  const stages = items(await listStages(db, actor, { projectId, apiId: state.rest.apiId }));
  const byName = Object.fromEntries(stages.map((stage) => [stage.name, stage]));
  // [stage, from, to, reason, daysAgo] — the last row per stage matches its current pointer.
  const timeline = [
    ["dev", null, v10, "deploy", 33], ["dev", v10, v11, "deploy", 22], ["dev", v11, v12, "deploy", 10], ["dev", v12, v13, "deploy", 1.3],
    ["staging", null, v11, "deploy", 21.5], ["staging", v11, v12, "deploy", 9.5], ["staging", v12, v13, "deploy", 1.28],
    ["prod", null, v10, "deploy", 32.8], ["prod", v10, v11, "deploy", 20.6], ["prod", v11, v12, "deploy", 8.7],
  ];
  const { data: existingHistory } = await pods.from("stage_history").select("id, stage_id, to_deployment_id, from_deployment_id").in("stage_id", stages.map((stage) => stage.id));
  for (const [stageName, from, to, reason, daysAgo] of timeline) {
    const stage = byName[stageName];
    if (!stage) continue;
    const existing = (existingHistory ?? []).find((row) => row.stage_id === stage.id && row.to_deployment_id === to.id);
    if (existing) {
      await update(supabase, "stage_history", { id: existing.id }, { created_at: ago(nowMs, daysAgo), from_deployment_id: from?.id ?? null });
      continue;
    }
    const { error } = await pods.from("stage_history").insert({
      project_id: projectId, stage_id: stage.id, from_deployment_id: from?.id ?? null, to_deployment_id: to.id,
      reason, actor_id: actor.userId, created_at: ago(nowMs, daysAgo),
    });
    if (error) throw new Error(`stage_history: ${error.message}`);
  }
  for (const [stageName, daysAgo] of [["dev", 33], ["staging", 21.5], ["prod", 32.8]]) {
    if (byName[stageName]) await update(supabase, "stages", { id: byName[stageName].id }, { created_at: ago(nowMs, daysAgo) });
  }
  log.item("= release timeline: v1.0 (33d) → v1.1 (21d) → v1.2 (9d) → v1.3 canary (1d)");
}
