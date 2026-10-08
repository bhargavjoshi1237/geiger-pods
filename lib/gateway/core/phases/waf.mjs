/**
 * `waf` phase (pipeline row 4).
 *
 * S11 implementation (replaces the S01 stub, keeping `name` + `run(ctx)`):
 * evaluates `artifact.edge.waf` (compiled web ACL + referenced IP/regex sets)
 * in priority order. `ALLOW`/`BLOCK` terminate; `COUNT` adds labels and
 * continues; otherwise the default action applies. A block throws
 * `WAF_FILTERED` (403 `{"message":"Forbidden"}`) or returns the rule's
 * custom response. Sets `$context.waf.{status,latency,error}`,
 * `$context.wafResponseCode` and `$context.webaclArn`, and records sampled
 * requests + access-log fields via the emit path (`ctx.wafAction`).
 *
 * No-op when the artifact carries no WAF config.
 *
 * @module lib/gateway/core/phases/waf
 */

import { GatewayError } from "../errors.mjs";
import {
  evaluateWebAcl,
  makeRequest,
  recordSampledRequest,
} from "../edge/waf-engine.mjs";

/** Phase name as listed in the pipeline table (§3). */
export const name = "waf";

/**
 * Runs WAF evaluation for one request.
 *
 * @param {object} ctx - Pipeline context (`request`, `artifact`, `context`, `ports`).
 * @returns {Promise<Response|undefined>} A custom block `Response`, or `undefined` to continue.
 * @throws {import("../errors.mjs").GatewayError} `WAF_FILTERED` on block without a custom response.
 */
export async function run(ctx) {
  const waf = ctx?.artifact?.edge?.waf ?? null;
  if (!waf || !waf.acl) return undefined;
  const started = ctx?.ports?.clock?.now?.() ?? Date.now();

  const headers = {};
  for (const [key, value] of ctx.request.headers.entries()) {
    const lower = key.toLowerCase();
    headers[lower] = [...(headers[lower] ?? []), value];
  }
  const url = new URL(ctx.request.url);
  let body = "";
  try {
    body = await ctx.request.clone().text();
  } catch {
    body = "";
  }
  const sourceIp = ctx?.context?.identity?.sourceIp
    ?? ctx.request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    ?? "";
  const req = makeRequest({
    method: ctx.request.method,
    path: url.pathname,
    query: url.search,
    headers,
    body,
    sourceIp,
  });

  const features = ctx?.artifact?.features ?? {};
  const countryHeader = features.wafCountryHeader ?? process.env.PODS_WAF_COUNTRY_HEADER ?? null;
  const country = countryHeader
    ? (headers[String(countryHeader).toLowerCase()]?.[0] ?? null)
    : (ctx?.ports?.geoCountry ? await safeGeo(ctx, sourceIp) : req.headers["x-pods-test-country"]?.[0] ?? null);
  const forwardedHeader = features.trustedProxyHeader ?? null;
  const forwardedIp = forwardedHeader
    ? (headers[String(forwardedHeader).toLowerCase()]?.[0]?.split(",")[0]?.trim() ?? null)
    : null;

  const verdict = await evaluateWebAcl({
    acl: waf.acl,
    req,
    wctx: {
      ipSets: new Map(Object.entries(waf.ipSets ?? {})),
      regexSets: new Map(Object.entries(waf.regexSets ?? {})),
      labels: new Set(),
      country,
      forwardedIp,
      trustedProxyHeader: forwardedHeader,
      kv: ctx?.ports?.kv ?? null,
      now: started,
      aclId: waf.acl?.name ?? "acl",
    },
  });
  const latency = (ctx?.ports?.clock?.now?.() ?? Date.now()) - started;

  if (ctx.context) {
    ctx.context.waf = {
      status: verdict.action === "BLOCK" ? "BLOCK" : verdict.action.startsWith("DEFAULT") ? verdict.action : "ALLOW",
      latency: String(latency),
      error: "",
    };
    ctx.context.wafResponseCode = verdict.wafResponseCode;
    ctx.context.webaclArn = waf.webAclArn ?? "";
  }
  ctx.wafAction = verdict.action === "BLOCK" || verdict.action === "DEFAULT_BLOCK" ? "BLOCK"
    : verdict.action === "ALLOW" || verdict.action === "DEFAULT_ALLOW" ? "ALLOW"
      : "COUNT";
  ctx.wafResponseCode = verdict.wafResponseCode;
  ctx.webaclArn = waf.webAclArn ?? "";
  ctx.wafLabels = [...verdict.labels];

  // Sampled requests (AWS "sampled requests"): terminating rule matches.
  if (verdict.terminatedBy && ctx?.ports?.kv) {
    try {
      await recordSampledRequest(ctx.ports.kv, {
        aclId: waf.acl?.name ?? "acl",
        stage: ctx?.stage ?? ctx?.artifact?.stage ?? "",
        ruleName: verdict.terminatedBy,
        req,
        action: verdict.action === "BLOCK" ? "BLOCK" : "ALLOW",
        now: started,
      });
    } catch {
      // Sampling never blocks.
    }
  }

  if (verdict.action === "BLOCK" || verdict.action === "DEFAULT_BLOCK") {
    if (verdict.customResponse) {
      const responseHeaders = new Headers({ "content-type": "application/json" });
      for (const [key, value] of Object.entries(verdict.customResponse.headers ?? {})) {
        responseHeaders.set(key, String(value));
      }
      const status = Number(verdict.customResponse.statusCode ?? 403);
      const bodyText = verdict.customResponse.bodyKey
        ? JSON.stringify({ message: verdict.customResponse.bodyKey })
        : JSON.stringify({ message: "Forbidden" });
      return new Response(bodyText, { status, headers: responseHeaders });
    }
    throw new GatewayError("WAF_FILTERED", "Forbidden");
  }
  return undefined;
}

async function safeGeo(ctx, sourceIp) {
  try {
    return await ctx.ports.geoCountry(sourceIp);
  } catch {
    return null;
  }
}
