/**
 * Custom-domain host resolution (S11 §A4).
 *
 * Pure functions the S05 loader and the `resolveEndpoint` phase share:
 * exact/wildcard domain matching, longest-prefix API mappings, routing-mode
 * dispatch, base-path validation, DNS-record display and DoH TXT parsing.
 * Results are cached per host for 5 s and invalidated on
 * `pods:domain-changed`.
 *
 * @module lib/gateway/core/edge/host-resolve
 */

import { randomBytes } from "node:crypto";
import {
  evaluateRoutingRules,
  validateRoutingRule,
} from "./routing-rules.mjs";

/** Pub/sub channel that invalidates cached host resolutions. */
export const DOMAIN_CHANGED_CHANNEL = "pods:domain-changed";

/** Cache TTL per host (S11 §A4). */
export const HOST_CACHE_TTL_MS = 5000;

/** Base-path segment charset (S11 §A1). */
export const BASE_PATH_SEGMENT = /^[A-Za-z0-9$_.+!*'()\-]+$/;

/**
 * Normalizes a domain/host: lowercase, trimmed, no trailing dot, no port.
 *
 * @param {string} value
 * @returns {string}
 */
export function normalizeDomainName(value) {
  return String(value ?? "").trim().toLowerCase().replace(/\.$/, "").split(":")[0];
}

/**
 * Returns true for wildcard domains (`*.example.com`, one `*` label only).
 *
 * @param {string} domainName
 * @returns {boolean}
 */
export function isWildcardDomain(domainName) {
  const normalized = normalizeDomainName(domainName);
  if (!normalized.startsWith("*.")) return false;
  return !normalized.slice(2).includes("*");
}

/**
 * Matches a host against a domain: exact, else one-level wildcard on the
 * parent label.
 *
 * @param {string} domainName - Configured domain (`api.example.com` or `*.example.com`).
 * @param {string} host - Request host (port stripped).
 * @returns {{ matched: boolean, wildcard: boolean, domainPrefix: string }}
 */
export function matchDomain(domainName, host) {
  const domain = normalizeDomainName(domainName);
  const candidate = normalizeDomainName(host);
  if (domain === candidate) {
    return { matched: true, wildcard: false, domainPrefix: candidate.split(".")[0] ?? "" };
  }
  if (isWildcardDomain(domain)) {
    const parent = domain.slice(2);
    if (candidate.endsWith(`.${parent}`)) {
      const labels = candidate.slice(0, -(parent.length + 1));
      if (labels && !labels.includes(".")) {
        return { matched: true, wildcard: true, domainPrefix: labels };
      }
    }
  }
  return { matched: false, wildcard: false, domainPrefix: "" };
}

/**
 * Validates an API-mapping base path (`''` = none, else segments
 * `[A-Za-z0-9$-_.+!*'()]`, multi-level `a/b/c`, no leading/trailing `/`).
 *
 * @param {string} value
 * @returns {string|null} Error message, or null when valid.
 */
export function validateBasePath(value) {
  if (value === "" || value === null || value === undefined) return null;
  if (typeof value !== "string") return "base path must be a string";
  if (value.startsWith("/")) return "base path must not have a leading \"/\"";
  if (value.endsWith("/")) return "base path must not have a trailing \"/\"";
  if (value.length > 512) return "base path must be at most 512 characters";
  for (const segment of value.split("/")) {
    if (segment === "" || !BASE_PATH_SEGMENT.test(segment)) {
      return `base path segment "${segment}" is invalid (allowed: [A-Za-z0-9$-_.+!*'()])`;
    }
  }
  return null;
}

/**
 * Resolves the longest matching base path at segment boundaries.
 *
 * @param {Array<{ basePath: string }>} mappings
 * @param {string} path - Request path.
 * @returns {{ mapping: object, stripped: string }|null} Null when only
 *   non-empty mappings exist and none match (the caller returns 403).
 */
export function resolveMapping(mappings, path) {
  const target = String(path ?? "/").split("?")[0] || "/";
  let best = null;
  let fallback = null;
  for (const mapping of mappings ?? []) {
    const base = String(mapping?.basePath ?? mapping?.base_path ?? "");
    if (base === "") {
      fallback = mapping;
      continue;
    }
    const prefix = `/${base}`;
    if (target === prefix || target.startsWith(`${prefix}/`)) {
      if (!best || base.length > String(best.basePath ?? best.base_path ?? "").length) best = mapping;
    }
  }
  if (best) {
    const base = String(best.basePath ?? best.base_path ?? "");
    const stripped = target.slice(base.length + 1) || "/";
    return { mapping: best, stripped: stripped.startsWith("/") ? stripped : `/${stripped}` };
  }
  if (fallback) return { mapping: fallback, stripped: target };
  return null;
}

/**
 * Resolves a custom-domain request to an API + stage (S11 §A4).
 *
 * Routing modes:
 * - `API_MAPPING_ONLY` (default): mappings only.
 * - `ROUTING_RULE_THEN_API_MAPPING`: first matching rule wins, else mappings.
 * - `ROUTING_RULE_ONLY`: first matching rule wins, else 404.
 *
 * @param {{ host: string, path: string, headers?: object, rawHeaders?: Array<[string,string]>,
 *   domain: { domainName: string, status?: string, routingMode?: string },
 *   mappings?: Array<object>, rules?: Array<object> }} options
 * @returns {{ apiId: string, stage: string, strippedPath: string, routingRuleId: string|null,
 *   basePathMatched: string, domainPrefix: string }|{ error: "forbidden"|"notFound" }}
 */
export function resolveCustomDomain({ host, path, headers = {}, rawHeaders = [], domain, mappings = [], rules = [] }) {
  const match = matchDomain(domain?.domainName ?? "", host);
  if (!match.matched) return { error: "forbidden" };
  // An unverified domain never routes (S11 §A2).
  if (domain?.status && domain.status !== "AVAILABLE" && domain.status !== "UPDATING") {
    return { error: "forbidden" };
  }
  const mode = domain?.routingMode ?? "API_MAPPING_ONLY";
  const cleanPath = String(path ?? "/").split("?")[0] || "/";

  if (mode === "ROUTING_RULE_ONLY" || mode === "ROUTING_RULE_THEN_API_MAPPING") {
    const hit = evaluateRoutingRules(rules, { headers, rawHeaders, path: cleanPath });
    if (hit) {
      const invoke = hit.action.invokeApi;
      let stripped = cleanPath;
      let basePathMatched = "";
      // A rule may name a base path to strip when configured to do so.
      const base = (hit.conditions?.matchBasePaths ?? [])[0];
      if (invoke.stripBasePath && base) {
        stripped = cleanPath.slice(String(base).replace(/^\/+|\/+$/g, "").length + 1) || "/";
        if (!stripped.startsWith("/")) stripped = `/${stripped}`;
        basePathMatched = String(base).replace(/^\/+|\/+$/g, "");
      }
      return {
        apiId: invoke.apiId ?? invoke.apiPublicId,
        stage: invoke.stage,
        strippedPath: stripped,
        routingRuleId: hit.id ?? String(hit.priority),
        basePathMatched,
        domainPrefix: match.domainPrefix,
      };
    }
    if (mode === "ROUTING_RULE_ONLY") return { error: "notFound" };
  }

  const resolved = resolveMapping(mappings, cleanPath);
  if (!resolved) return { error: "forbidden" };
  const mapping = resolved.mapping;
  return {
    // Loaders carry the public id (`apiPublicId`); unit callers use `apiId`.
    apiId: mapping.apiId ?? mapping.apiPublicId ?? mapping.api_id,
    stage: mapping.stage ?? mapping.stage_name,
    strippedPath: resolved.stripped,
    routingRuleId: null,
    basePathMatched: String(mapping.basePath ?? mapping.base_path ?? ""),
    domainPrefix: match.domainPrefix,
  };
}

/**
 * Applies a custom-domain match to a pipeline context: `$context.domainName`,
 * `domainPrefix`, `customDomain.*`, request path and stage.
 *
 * @param {object} ctx - Pipeline context.
 * @param {{ strippedPath: string, routingRuleId: string|null, basePathMatched: string,
 *   domainPrefix: string, domainName: string, apiPublicId?: string, stage?: string }} resolved
 */
export function applyCustomDomainMatch(ctx, resolved) {
  if (ctx.context) {
    ctx.context.domainName = resolved.domainName;
    ctx.context.domainPrefix = resolved.domainPrefix ?? "";
    ctx.context.customDomain = {
      basePathMatched: resolved.basePathMatched ?? "",
      routingRuleIdMatched: resolved.routingRuleId ?? "",
    };
  }
  ctx.requestPath = resolved.strippedPath;
  ctx.basePathStripped = resolved.strippedPath;
  if (resolved.stage) ctx.stage = resolved.stage;
  if (resolved.apiPublicId) ctx.apiPublicId = resolved.apiPublicId;
  ctx.viaCustomDomain = true;
  ctx.viaDefaultEndpoint = false;
}

/**
 * Creates a per-host resolution cache (5 s TTL, S11 §A4).
 *
 * @param {{ ttlMs?: number }} [options={}]
 * @returns {{ get(host: string, now?: number): object|undefined,
 *   set(host: string, value: object, now?: number): void,
 *   invalidate(host?: string|null): void }}
 */
export function createHostCache({ ttlMs = HOST_CACHE_TTL_MS } = {}) {
  const entries = new Map();
  return {
    get(host, now = Date.now()) {
      const entry = entries.get(normalizeDomainName(host));
      if (!entry || entry.expiresAt <= now) {
        entries.delete(normalizeDomainName(host));
        return undefined;
      }
      return entry.value;
    },
    set(host, value, now = Date.now()) {
      entries.set(normalizeDomainName(host), { value, expiresAt: now + ttlMs });
    },
    invalidate(host = null) {
      if (host === null || host === undefined) {
        entries.clear();
        return;
      }
      entries.delete(normalizeDomainName(host));
    },
  };
}

/**
 * Generates a domain ownership verification token (32 url-safe chars).
 *
 * @returns {string}
 */
export function newVerificationToken() {
  return randomBytes(24).toString("base64url");
}

/**
 * Builds the DNS records a user must add for a domain (S11 §A2).
 *
 * @param {{ domainName: string, verificationToken: string, targetHostname: string }} domain
 * @returns {Array<{ type: string, name: string, value: string, note?: string }>}
 */
export function dnsRecordsFor(domain) {
  const name = normalizeDomainName(domain?.domainName ?? "");
  const parent = name.startsWith("*.") ? name.slice(2) : name;
  const apex = !parent.includes(".") || name === parent.replace(/^[a-z0-9-]+\./, "");
  void apex;
  return [
    {
      type: "TXT",
      name: `_pods-challenge.${parent}`,
      value: domain?.verificationToken ?? "",
    },
    {
      type: "CNAME",
      name: parent,
      value: domain?.targetHostname ?? "",
      note: "For an apex, use ALIAS/ANAME (or A/AAAA to the published runtime IPs).",
    },
  ];
}

/**
 * Checks a DNS-over-HTTPS JSON answer for the challenge TXT value.
 *
 * @param {object} dohJson - DoH `resolve?name=…&type=TXT` response body.
 * @param {string} token - Expected verification token.
 * @returns {boolean}
 */
export function checkDohTxtAnswer(dohJson, token) {
  const answers = dohJson?.Answer ?? [];
  for (const entry of answers) {
    const data = String(entry?.data ?? "").replace(/^"|"$/g, "");
    if (data === token) return true;
  }
  return false;
}

export { validateRoutingRule };
