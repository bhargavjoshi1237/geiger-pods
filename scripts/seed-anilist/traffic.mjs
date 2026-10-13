#!/usr/bin/env node
// Drives real traffic through a running gateway (gateway-local.mjs) via the
// anime.geiger-notes.dev custom domain (Host header), exercising every
// request-path feature and printing what each one returned. Stays under
// AniList's 30 req/min: repeated lookups are served from the prod cache.
//
//   node scripts/seed-anilist/traffic.mjs [gatewayOrigin]   (default http://127.0.0.1:4000)
//
// Domain mappings: /v1 → AniList Explorer prod, /v1-preview → staging,
// /graphql → AniList GraphQL Edge ($default).

import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { ROOT } from "./context.mjs";

const origin = new URL(process.argv[2] ?? "http://127.0.0.1:4000");
const DOMAIN = "anime.geiger-notes.dev";
const out = join(ROOT, "scripts", "seed-anilist", "output");
const keys = JSON.parse(readFileSync(join(out, "api-keys.json"), "utf8"));
const demo = keys["Demo Presenter"].value;
const free = keys["Weeb Discord Bot"].value;
const disabled = keys["Hackathon Team 7"].value;
const qa = keys["QA Smoke Tests"].value;

/** fetch() drops a custom Host header, so use node:http directly. */
function send(path, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: origin.hostname, port: origin.port || 80, path, method,
      headers: { host: DOMAIN, "user-agent": "GeigerShowcase/1.0 (+demo)", ...(body ? { "content-length": Buffer.byteLength(body) } : {}), ...headers },
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8"), headers: res.headers }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

let failed = 0;
async function call(label, path, { expect, ...options } = {}) {
  const started = Date.now();
  const res = await send(path, options);
  const ms = Date.now() - started;
  const code = res.text.match(/"code":\s*"([A-Z_]+)"/)?.[1] ?? "";
  const ok = expect === undefined || (Array.isArray(expect) ? expect.includes(res.status) : res.status === expect);
  if (!ok) failed += 1;
  console.log(`${ok ? "✓" : "✗"} ${String(res.status).padEnd(4)} ${String(ms).padStart(5)}ms ${label.padEnd(46)} ${code}${!ok ? `  ← expected ${expect}: ${res.text.slice(0, 160)}` : ""}`);
  return res;
}

const key = (value) => ({ "x-api-key": value });
const json = (value) => ({ "x-api-key": value, "content-type": "application/json" });

console.log(`Gateway ${origin.origin} · Host: ${DOMAIN}\n`);
console.log("— Happy paths (prod via /v1)");
await call("GET /health (mock integration)", "/v1/health", { expect: 200 });
await call("GET /anime/trending (public, no key)", "/v1/anime/trending", { expect: 200 });
await call("GET /anime/trending again (stage cache)", "/v1/anime/trending", { expect: 200 });
for (const id of [154587, 21, 16498, 154587, 21]) {
  await call(`GET /anime/${id}`, `/v1/anime/${id}`, { headers: key(demo), expect: 200 });
}
await call("GET /anime/search?q=Frieren", "/v1/anime/search?q=Frieren", { headers: key(demo), expect: 200 });
await call("GET /anime/search?q=JoJo's&genre=Action", "/v1/anime/search?q=JoJo%27s&genre=Action", { headers: key(demo), expect: 200 });
await call("GET /anime/seasonal/2026/fall", "/v1/anime/seasonal/2026/fall", { headers: key(demo), expect: 200 });
await call("GET /anime/154587/characters", "/v1/anime/154587/characters", { headers: key(demo), expect: 200 });
await call("GET /anime/154587/recommendations", "/v1/anime/154587/recommendations", { headers: key(demo), expect: 200 });
await call("GET /manga/30013", "/v1/manga/30013", { headers: key(demo), expect: 200 });
await call("GET /characters/40", "/v1/characters/40", { headers: key(demo), expect: 200 });
await call("GET /staff/95185", "/v1/staff/95185", { headers: key(demo), expect: 200 });
await call("GET /studios/11", "/v1/studios/11", { headers: key(demo), expect: 200 });
await call("GET /schedule/airing", "/v1/schedule/airing", { headers: key(demo), expect: 200 });
await call("POST /graphql (passthrough, partner key)", "/v1/graphql", {
  method: "POST", headers: json(demo), body: JSON.stringify({ query: "{ Media(id: 1) { title { romaji } } }" }), expect: 200,
});

console.log("\n— Errors, validation and auth");
await call("GET /anime/99999999 → branded 404", "/v1/anime/99999999", { headers: key(demo), expect: 404 });
await call("GET /anime/search (missing q) → 400", "/v1/anime/search", { headers: key(demo), expect: 400 });
await call("POST /graphql invalid body → 400", "/v1/graphql", { method: "POST", headers: json(demo), body: JSON.stringify({ variables: {} }), expect: 400 });
await call("GET /anime/21 without key → 403", "/v1/anime/21", { expect: 403 });
await call("GET /anime/21 bogus key → 403", "/v1/anime/21", { headers: key("not-a-real-key-000000000000"), expect: 403 });
await call("GET /anime/21 disabled key → 403", "/v1/anime/21", { headers: key(disabled), expect: 403 });
await call("GET /me without SSO token → 401", "/v1/me", { expect: 401 });
await call("POST /partners/exports, no partner token", "/v1/partners/exports", { method: "POST", headers: key(demo), expect: [401, 403] });
await call("GET /nope → branded unknown route", "/v1/nope", { headers: key(demo), expect: [403, 404] });

console.log("\n— Web application firewall");
await call("scraper user-agent → blocked", "/v1/anime/21", { headers: { ...key(demo), "user-agent": "python-requests/2.31" }, expect: 403 });
await call("SQL injection in query → blocked", "/v1/anime/search?q=1%27%20OR%201=1--", { headers: key(demo), expect: 403 });
await call("staging (/v1-preview) from outside office", "/v1-preview/health", { expect: 403 });
await call("staging with QA header → allowed", "/v1-preview/health", { headers: { "x-qa-run": "qa-smoke" }, expect: 200 });
await call("staging, QA key + header", "/v1-preview/anime/21", { headers: { ...key(qa), "x-qa-run": "qa-smoke" }, expect: 200 });

console.log("\n— Throttling (Genin · Free: 2 rps, burst 5)");
const burst = await Promise.all(Array.from({ length: 12 }, () => send("/v1/anime/154587", { headers: key(free) }).then((r) => r.status)));
const tally = burst.reduce((acc, status) => ({ ...acc, [status]: (acc[status] ?? 0) + 1 }), {});
if (!tally[429]) failed += 1;
console.log(`${tally[429] ? "✓" : "✗"} 12 parallel calls with the free key → ${JSON.stringify(tally)}`);

console.log("\n— HTTP API (AniList GraphQL Edge via /graphql)");
await call("POST /graphql", "/graphql/graphql", {
  method: "POST", headers: { "content-type": "application/json", origin: "https://anime.geiger-notes.dev" },
  body: JSON.stringify({ query: "{ Page(perPage: 3) { media(sort: TRENDING_DESC) { title { romaji } } } }" }), expect: 200,
});
await call("POST /graphql/viewer without JWT → 401", "/graphql/graphql/viewer", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: "{ Viewer { id } }" }), expect: 401,
});
console.log(failed ? `\n${failed} unexpected result(s).` : "\nAll scenarios behaved as designed.");
process.exitCode = failed ? 1 : 0;
