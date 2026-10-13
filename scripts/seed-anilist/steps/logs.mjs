// Three days of access logs, execution logs and trace spans so the Logs and
// request-detail screens have history beyond today's live traffic.
// Needs the observability partition migration
// (20261021000001_log_partitions_span_ts); skips with a hint until it is
// applied. Re-runnable: skipped once seeded rows exist.

import { randomUUID } from "node:crypto";

const MINUTE = 60000;

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

const IPS = ["49.36.112.18", "103.21.58.77", "122.171.20.5", "73.162.11.94", "91.207.174.30", "2.50.18.240", "185.199.110.42", "151.101.65.9"];
const AGENTS = ["OtakuTracker/3.8 (iOS 18.1)", "SeasonalChart/2026.10 (+https://seasonal-chart.app)", "WeebBot/1.4 discord.js", "CrunchyRecs-Batch/0.9", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0", "MangaReader/0.3 (Android 15)"];

// [weight, method, resourcePath, concrete(rand) → path, apiKeyName|null]
const OPS = [
  [26, "GET", "/anime/{id}", (r) => `/anime/${[154587, 21, 16498, 1535, 5114, 11061, 166240][Math.floor(r() * 7)]}`],
  [14, "GET", "/anime/search", (r) => `/anime/search?q=${["Frieren", "Dandadan", "One Piece", "Solo Leveling", "Kaiju"][Math.floor(r() * 5)]}`],
  [18, "GET", "/anime/trending", () => "/anime/trending"],
  [6, "GET", "/anime/seasonal/{year}/{season}", () => "/anime/seasonal/2026/fall"],
  [6, "GET", "/anime/{id}/characters", () => "/anime/154587/characters"],
  [5, "GET", "/manga/{id}", () => "/manga/30013"],
  [4, "GET", "/characters/{id}", () => "/characters/40"],
  [5, "GET", "/schedule/airing", () => "/schedule/airing"],
  [4, "POST", "/graphql", () => "/graphql"],
  [2, "GET", "/anime/{id}/streaming", () => "/anime/21/streaming"],
];
const TOTAL_WEIGHT = OPS.reduce((sum, op) => sum + op[0], 0);

function pickOp(r) {
  let roll = r() * TOTAL_WEIGHT;
  for (const op of OPS) {
    roll -= op[0];
    if (roll <= 0) return op;
  }
  return OPS[0];
}

export async function seedLogs(ctx, state) {
  const { supabase, projectId, log } = ctx;
  const pods = supabase.schema("pods");
  log.section("Request logs & traces (3 days)");
  const { count, error: countError } = await pods.from("access_logs").select("id", { count: "exact", head: true })
    .eq("project_id", projectId).lt("ts", new Date(Date.now() - 2 * 3600000).toISOString());
  if (countError) throw new Error(`access_logs: ${countError.message}`);
  if (count) {
    log.skip(`${count} historical access log rows`);
    return;
  }

  const nowMs = Date.now();
  const r = prng(7);
  const access = [];
  const execution = [];
  const spans = [];
  const TOTAL = 420;
  for (let i = 1; i <= TOTAL; i += 1) {
    const [, method, resourcePath, concrete] = pickOp(r);
    const canary = resourcePath === "/anime/{id}/streaming" || r() < 0.08;
    const stage = canary ? "prod/Canary" : "prod";
    if (resourcePath === "/anime/{id}/streaming" && !canary) continue;
    const ts = new Date(nowMs - ((i / TOTAL) ** 1.5) * 3 * 24 * 60 * MINUTE - 3 * MINUTE).toISOString();
    const roll = r();
    const status = roll < 0.012 ? 502 : roll < 0.02 ? 504 : roll < 0.045 ? 429 : roll < 0.075 ? 403 : roll < 0.09 ? 404 : roll < 0.1 ? 400 : 200;
    const cacheHit = method === "GET" && status === 200 && r() < 0.68;
    const latency = Math.round(cacheHit ? 8 + r() * 30 : (status >= 500 ? 2400 + r() * 7000 : 180 + r() * 520));
    const requestId = randomUUID();
    const ip = IPS[Math.floor(r() * IPS.length)];
    const agent = AGENTS[Math.floor(r() * AGENTS.length)];
    const path = concrete(r);
    const keyId = resourcePath === "/anime/trending" ? "-" : `key_${Math.floor(r() * 9) + 1}`;
    access.push({
      project_id: projectId, api_id: state.rest.apiId, stage, ts, request_id: requestId, status,
      route: `${method} ${resourcePath}`, source_ip: ip,
      line: `${requestId} ${ip} ${method} ${resourcePath} ${status} ${latency} ${keyId}`,
      fields: {
        requestId, ip, httpMethod: method, resourcePath, path, status, responseLatency: latency,
        protocol: "HTTP/1.1", userAgent: agent, apiId: state.rest.publicId, cache: cacheHit ? "HIT" : "MISS",
        domainName: "anime.geiger-notes.dev",
      },
    });
    if (status >= 400 || latency > 900 || i % 5 === 0) {
      const at = Date.parse(ts);
      const lines = [
        `Extended Request Id: ${requestId.slice(0, 8).toUpperCase()}=`,
        `Verifying Usage Plan for request: ${requestId}. API Key: ****${requestId.slice(-4)}`,
        cacheHit ? "Cache hit for the request" : "Cache miss for the request",
        `Method request path: {resourcePath=${resourcePath}}`,
        `Endpoint request URI: https://graphql.anilist.co`,
        "Endpoint request headers: {Content-Type=application/json, Accept=application/json, X-Geiger-Client=****}",
        `Received response. Status: ${status >= 500 ? status : 200}, Integration latency: ${Math.max(1, latency - 12)} ms`,
        status === 404 ? "Integration response selection pattern 404 matched; applying NOT_FOUND template" : "Method response body after transformations: {\"id\": …}",
      ].map((message, index) => ({ level: "INFO", message, ts: new Date(at + index).toISOString() }));
      if (status >= 500) lines.splice(6, 0, { level: "ERROR", message: status === 504 ? "Execution failed due to a timeout error: graphql.anilist.co did not respond within 10000 ms" : "Execution failed: AniList returned 502 Bad Gateway", ts: new Date(at + 6).toISOString() });
      execution.push({ project_id: projectId, api_id: state.rest.apiId, stage, request_id: requestId, ts, level: status >= 500 ? "ERROR" : "INFO", lines, data_trace: false });
    }
    if (i % 4 === 0) {
      const startMs = Date.parse(ts);
      const traceId = `1-${Math.floor(startMs / 1000).toString(16)}-${requestId.replace(/-/g, "").slice(0, 24)}`;
      const integrationMs = cacheHit ? 0 : Math.max(1, latency - 14);
      const parts = [
        { name: `${state.rest.publicId}/${stage}`, kind: "server", start: 0, duration: latency, parent: null },
        { name: "waf anilist-edge-shield", kind: "internal", start: 0, duration: 1, parent: 0 },
        { name: "api key + usage plan", kind: "internal", start: 1, duration: 2, parent: 0 },
        ...(cacheHit ? [{ name: "stage cache HIT", kind: "internal", start: 3, duration: Math.max(1, latency - 4), parent: 0 }]
          : [{ name: `POST graphql.anilist.co (${method} ${resourcePath})`, kind: "client", start: 3, duration: integrationMs, parent: 0 },
            { name: "response mapping template", kind: "internal", start: 3 + integrationMs, duration: Math.max(1, latency - integrationMs - 3), parent: 0 }]),
      ];
      const ids = parts.map(() => randomUUID().replace(/-/g, "").slice(0, 16));
      parts.forEach((span, index) => spans.push({
        project_id: projectId, api_id: state.rest.apiId, stage, request_id: requestId, trace_id: traceId,
        span_id: ids[index], parent_id: span.parent === null ? null : ids[span.parent], name: span.name, kind: span.kind,
        attributes: { "http.method": method, "http.route": resourcePath, "http.status_code": status, "pods.cache": cacheHit ? "HIT" : "MISS" },
        start_ms: startMs + span.start, end_ms: startMs + span.start + span.duration, duration_ms: span.duration,
        status: status >= 500 && span.kind !== "internal" ? "error" : "ok", ts,
      }));
    }
  }
  for (const [table, rows] of [["access_logs", access], ["execution_logs", execution], ["trace_spans", spans]]) {
    for (let index = 0; index < rows.length; index += 500) {
      const { error } = await pods.from(table).insert(rows.slice(index, index + 500));
      if (error) {
        if (/no partition|column "ts"|ts.*does not exist/i.test(error.message)) {
          log.item(`! ${table}: ${error.message} — run \`npm run db:push\` (log partitions migration), then re-run --only logs`);
          return;
        }
        throw new Error(`${table}: ${error.message}`);
      }
    }
  }
  log.item(`+ ${access.length} access logs, ${execution.length} execution logs, ${spans.length} trace spans`);
}
