/**
 * JWT authorizer (S07 §4: REST `COGNITO_USER_POOLS` behavior, HTTP `JWT`).
 *
 * Token source: the authorizer's identity source (default
 * `$request.header.Authorization`; REST default
 * `method.request.header.Authorization`). A leading `Bearer ` (any case) is
 * stripped. Discovery: `GET {issuer}/.well-known/openid-configuration` →
 * `jwks_uri`, fetched with the caller's `ports.fetch` (the runtime host wraps
 * it with the SSRF guard). JWKS responses are cached in KV for 2 h; an
 * unknown `kid` triggers one refetch, rate-limited to 1/min per issuer.
 *
 * Validation: header `alg` must be listed in `algorithms` (never `none`;
 * `HS*` never accepted). Signature verified by `kid` with WebCrypto. `iss`
 * must equal exactly. `exp` is required and in the future; `nbf`/`iat` must
 * not be in the future (± `clockSkewSec`). Audience passes when `aud`
 * (string or array) **or** `client_id` contains a configured audience (AWS
 * semantics). Scopes (`authorization_scopes` on the route/method) need at
 * least one of the token's `scope` (space-delimited) / `scp` (array) entries,
 * else 403.
 *
 * Failures: missing token → 401 `UNAUTHORIZED`; invalid/expired → 401
 * (`EXPIRED_TOKEN` is reserved for signed requests). On success the caller
 * sets `$context.authorizer.claims.<name>` (non-strings stringified, as AWS
 * does), `.scopes` and `.principalId = sub`.
 *
 * Pure except for the injected ports (`fetch`, `kv`, `clock`).
 *
 * @module lib/gateway/core/auth/jwt
 */

import { GatewayError } from "../errors.mjs";
import { resolveIdentitySource } from "./custom.mjs";

/** JWKS cache TTL: 2 h. Unknown-kid refetch rate limit: 1/min per issuer. */
export const JWKS_TTL_MS = 2 * 60 * 60 * 1000;
export const KID_REFETCH_TTL_MS = 60 * 1000;

/** Default identity source for JWT authorizers (HTTP + REST). */
export const DEFAULT_JWT_IDENTITY_SOURCE = "$request.header.Authorization";

/**
 * Strips a leading `Bearer ` (case-insensitive) from a token value.
 *
 * @param {string} value
 * @returns {string}
 */
export function stripBearer(value) {
  return String(value ?? "").replace(/^[Bb][Ee][Aa][Rr][Ee][Rr]\s+/, "").trim();
}

/**
 * Decodes a JWT without verifying (JWT debugger box, no network).
 *
 * @param {string} token
 * @returns {{ header: object, payload: object }}
 * @throws {GatewayError} `UNAUTHORIZED` when malformed.
 */
export function decodeJwt(token) {
  const parts = stripBearer(token).split(".");
  if (parts.length !== 3) throw new GatewayError("UNAUTHORIZED", "Unauthorized");
  try {
    return {
      header: JSON.parse(base64UrlToText(parts[0])),
      payload: JSON.parse(base64UrlToText(parts[1])),
    };
  } catch {
    throw new GatewayError("UNAUTHORIZED", "Unauthorized");
  }
}

/**
 * URL-safe base64 encoding without padding (JWT segments, Web API only).
 *
 * @param {Uint8Array|Array<number>} bytes
 * @returns {string}
 */
export function base64UrlEncode(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes ?? []);
  let binary = "";
  const CHUNK = 8192;
  for (let index = 0; index < data.length; index += CHUNK) {
    binary += String.fromCharCode(...data.subarray(index, index + CHUNK));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Reads one identity-source expression from plain request bags (the JWT
 * debugger / test shape: `{ headers, query, stageVariables, context }`).
 * Returns `null` when the source is absent. For live pipeline requests use
 * {@link resolveIdentitySource} with a Web `Request` instead.
 *
 * @param {string} expression - Identity source expression.
 * @param {{ headers?: Headers|Record<string,string>, query?: URLSearchParams|Record<string,string>, stageVariables?: object, context?: object }} [bags={}]
 * @returns {string|null}
 */
export function readIdentitySource(expression, { headers, query, stageVariables = {}, context = {} } = {}) {
  const expr = String(expression ?? "").trim();
  const getHeader = (name) => {
    if (!headers) return null;
    if (typeof headers.get === "function") {
      const value = headers.get(name);
      return value === null ? null : String(value);
    }
    const lower = String(name).toLowerCase();
    for (const key of Object.keys(headers ?? {})) {
      if (key.toLowerCase() === lower) return String(headers[key]);
    }
    return null;
  };
  let match = expr.match(/^method\.request\.header\.(.+)$/i) ?? expr.match(/^\$request\.header\.(.+)$/i);
  if (match) return getHeader(match[1]);
  match = expr.match(/^method\.request\.querystring\.(.+)$/i) ?? expr.match(/^\$request\.querystring\.(.+)$/i);
  if (match) {
    const params = query instanceof URLSearchParams ? query : new URLSearchParams(query ?? {});
    const value = params.get(match[1]);
    return value === null ? null : String(value);
  }
  match = expr.match(/^\$stageVariables\.(.+)$/);
  if (match) {
    const value = stageVariables?.[match[1]];
    return value === null || value === undefined || value === "" ? null : String(value);
  }
  match = expr.match(/^\$context\.(.+)$/);
  if (match) {
    let current = context;
    for (const segment of match[1].split(".")) {
      if (segment === "__proto__" || segment === "constructor" || segment === "prototype") return null;
      if (current === null || current === undefined || typeof current !== "object") return null;
      current = current[segment];
    }
    return current === null || current === undefined || current === "" ? null : String(current);
  }
  return null;
}

/**
 * Authorizes one request against a JWT authorizer row (control-plane shape:
 * `{ identitySource, jwt: { issuer, audience, algorithms, clockSkewSec },
 * scopes }`) and plain request bags. Missing token → 401 without network;
 * scope mismatches → 403.
 *
 * @param {{ headers?: Headers|Record<string,string>, query?: URLSearchParams|Record<string,string>, stageVariables?: object, context?: object }} sources
 * @param {{ identitySource?: Array<string>, jwt?: object, scopes?: Array<string> }} authorizer
 * @param {{ fetch: Function, kv?: object|null, clock?: { now(): number }, now?: number }} ports
 * @returns {Promise<{ claims: object, scopes: Array<string>, principalId: string, raw: object }}>}
 * @throws {GatewayError} `UNAUTHORIZED` / `ACCESS_DENIED` /
 * `AUTHORIZER_CONFIGURATION_ERROR`.
 */
export async function authorizeJwt(sources = {}, authorizer = {}, ports = {}) {
  const identitySource = authorizer?.identitySource?.length > 0
    ? authorizer.identitySource
    : [DEFAULT_JWT_IDENTITY_SOURCE];
  const raw = readIdentitySource(identitySource[0], sources);
  if (raw === null || String(raw).trim() === "") throw new GatewayError("UNAUTHORIZED", "Unauthorized");
  const jwt = authorizer?.jwt ?? {};
  const clock = ports?.clock
    ?? (typeof ports?.now === "number" ? { now: () => ports.now } : undefined);
  return verifyJwt({
    token: stripBearer(String(raw)),
    authorizer: {
      issuer: jwt.issuer,
      audience: jwt.audience ?? jwt.audiences ?? [],
      algorithms: jwt.algorithms,
      clockSkewSec: jwt.clockSkewSec ?? jwt.clock_skew_sec ?? 0,
    },
    ports: { fetch: ports?.fetch, kv: ports?.kv ?? null, clock },
    requiredScopes: authorizer?.scopes ?? [],
  });
}

function base64UrlToBytes(segment) {
  const padded = segment.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function base64UrlToText(segment) {
  const bytes = base64UrlToBytes(segment);
  return new TextDecoder().decode(bytes);
}

/**
 * Extracts the raw token from the request using the authorizer's identity
 * source. Missing/empty → `null` (caller renders 401 without verifying).
 *
 * @param {{ identitySource?: Array<string> }} authorizer
 * @param {{ request: Request, stageVariables?: object, context?: object, pathParameters?: object }} input
 * @returns {string|null}
 */
export function extractJwtToken(authorizer, { request, stageVariables = {}, context = {}, pathParameters = {} } = {}) {
  const sources = authorizer?.identitySource?.length > 0 ? authorizer.identitySource : [DEFAULT_JWT_IDENTITY_SOURCE];
  const value = resolveIdentitySource(sources[0], { request, stageVariables, context, pathParameters });
  if (value === null || value === undefined || String(value).trim() === "") return null;
  return stripBearer(String(value));
}

function jwksKey(issuer) {
  return `jwks:keys:${issuer}`;
}

function refetchKey(issuer) {
  return `jwks:refetch:${issuer}`;
}

async function readJsonCache(kv, key) {
  const raw = await kv.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Loads the JWKS for an issuer (KV-cached 2 h, discovered via
 * `/.well-known/openid-configuration`).
 *
 * @param {string} issuer
 * @param {{ fetch: Function, kv: object }} ports
 * @param {{ force?: boolean }} [options={}]
 * @returns {Promise<{ keys: Array<object> }>}
 */
export async function loadJwks(issuer, ports, { force = false } = {}) {
  const kv = ports?.kv ?? null;
  if (!force && kv) {
    const cached = await readJsonCache(kv, jwksKey(issuer));
    if (cached?.keys) return cached;
  }
  const discoveryUrl = `${String(issuer).replace(/\/+$/, "")}/.well-known/openid-configuration`;
  const discoveryRes = await ports.fetch(discoveryUrl, { method: "GET" });
  if (!discoveryRes.ok) throw new GatewayError("AUTHORIZER_CONFIGURATION_ERROR", "Internal server error");
  const discovery = await discoveryRes.json();
  if (!discovery?.jwks_uri || typeof discovery.jwks_uri !== "string") {
    throw new GatewayError("AUTHORIZER_CONFIGURATION_ERROR", "Internal server error");
  }
  const jwksRes = await ports.fetch(discovery.jwks_uri, { method: "GET" });
  if (!jwksRes.ok) throw new GatewayError("AUTHORIZER_CONFIGURATION_ERROR", "Internal server error");
  const jwks = await jwksRes.json();
  if (!jwks || !Array.isArray(jwks.keys)) {
    throw new GatewayError("AUTHORIZER_CONFIGURATION_ERROR", "Internal server error");
  }
  if (kv) await kv.set(jwksKey(issuer), JSON.stringify({ keys: jwks.keys }), { ttlMs: JWKS_TTL_MS });
  return { keys: jwks.keys };
}

function subtleForAlg(alg, jwk) {
  if (alg === "RS256" || alg === "RS384" || alg === "RS512") {
    const hash = alg === "RS256" ? "SHA-256" : alg === "RS384" ? "SHA-384" : "SHA-512";
    return { importAlg: { name: "RSASSA-PKCS1-v1_5", hash }, verifyAlg: { name: "RSASSA-PKCS1-v1_5" } };
  }
  if (alg === "ES256" || alg === "ES384" || alg === "ES512") {
    const hash = alg === "ES256" ? "SHA-256" : alg === "ES384" ? "SHA-384" : "SHA-512";
    return { importAlg: { name: "ECDSA", namedCurve: jwk.crv ?? "P-256" }, verifyAlg: { name: "ECDSA", hash } };
  }
  return null;
}

async function verifySignature(headerB64, payloadB64, signatureB64, jwk, alg) {
  const mapping = subtleForAlg(alg, jwk);
  if (!mapping) return false;
  try {
    const key = await crypto.subtle.importKey("jwk", jwk, mapping.importAlg, false, ["verify"]);
    const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
    return await crypto.subtle.verify(mapping.verifyAlg, key, base64UrlToBytes(signatureB64), data);
  } catch {
    return false;
  }
}

function audienceOk(payload, audiences) {
  if (!audiences || audiences.length === 0) return true;
  const wanted = new Set(audiences.map(String));
  const aud = payload.aud;
  const candidates = [
    ...(Array.isArray(aud) ? aud : aud !== undefined ? [aud] : []),
    ...(payload.client_id !== undefined ? [payload.client_id] : []),
  ].map(String);
  return candidates.some((candidate) => wanted.has(candidate));
}

/**
 * Verifies a JWT against an authorizer config.
 *
 * @param {{ token: string|null, authorizer: { issuer: string, audience?: Array<string>, algorithms?: Array<string>, clockSkewSec?: number }, ports: { fetch: Function, kv: object, clock?: { now(): number } }, requiredScopes?: Array<string> }} input
 * @returns {Promise<{ claims: object, scopes: Array<string>, principalId: string, raw: object }}>}
 * @throws {GatewayError} `UNAUTHORIZED` (missing/invalid/expired) or
 * `ACCESS_DENIED` (scope check) / `AUTHORIZER_CONFIGURATION_ERROR` (bad JWKS).
 */
export async function verifyJwt({ token, authorizer, ports, requiredScopes = [] } = {}) {
  if (!token || String(token).trim() === "") throw new GatewayError("UNAUTHORIZED", "Unauthorized");
  const config = authorizer ?? {};
  const issuer = config.issuer;
  if (!issuer) throw new GatewayError("AUTHORIZER_CONFIGURATION_ERROR", "Internal server error");
  const algorithms = config.algorithms?.length > 0 ? config.algorithms : ["RS256"];
  const skewSec = Number(config.clockSkewSec ?? 0);
  const nowMs = ports?.clock?.now?.() ?? Date.now();

  const raw = stripBearer(String(token).trim());
  if (raw === "") throw new GatewayError("UNAUTHORIZED", "Unauthorized");
  const parts = raw.split(".");
  if (parts.length !== 3) throw new GatewayError("UNAUTHORIZED", "Unauthorized");
  let header;
  let payload;
  try {
    header = JSON.parse(base64UrlToText(parts[0]));
    payload = JSON.parse(base64UrlToText(parts[1]));
  } catch {
    throw new GatewayError("UNAUTHORIZED", "Unauthorized");
  }
  const alg = header?.alg;
  if (typeof alg !== "string" || alg.toLowerCase() === "none" || /^HS/i.test(alg) || !algorithms.includes(alg)) {
    throw new GatewayError("UNAUTHORIZED", "Unauthorized");
  }
  if (!payload || typeof payload !== "object") throw new GatewayError("UNAUTHORIZED", "Unauthorized");

  let jwks = await loadJwks(issuer, ports);
  let key = (jwks.keys ?? []).find((entry) => entry?.kid === header.kid && (entry?.alg === undefined || entry.alg === alg));
  if (!key && !(jwks.keys ?? []).some((entry) => entry?.kid === header.kid)) {
    // Unknown kid: a single refetch, rate-limited to 1/min per issuer
    // (stateless ports without KV refetch every time).
    const kv = ports?.kv ?? null;
    const marker = kv ? await kv.get(refetchKey(issuer)) : null;
    if (marker === null) {
      if (kv) await kv.set(refetchKey(issuer), "1", { ttlMs: KID_REFETCH_TTL_MS });
      jwks = await loadJwks(issuer, ports, { force: true });
      key = (jwks.keys ?? []).find((entry) => entry?.kid === header.kid && (entry?.alg === undefined || entry.alg === alg));
    }
  }
  if (!key) throw new GatewayError("UNAUTHORIZED", "Unauthorized");
  const valid = await verifySignature(parts[0], parts[1], parts[2], key, alg);
  if (!valid) throw new GatewayError("UNAUTHORIZED", "Unauthorized");

  if (payload.iss !== issuer) throw new GatewayError("UNAUTHORIZED", "Unauthorized");
  const skewMs = skewSec * 1000;
  if (typeof payload.exp !== "number" || !(payload.exp * 1000 > nowMs)) {
    throw new GatewayError("UNAUTHORIZED", "Unauthorized");
  }
  if (typeof payload.nbf === "number" && payload.nbf * 1000 > nowMs + skewMs) {
    throw new GatewayError("UNAUTHORIZED", "Unauthorized");
  }
  if (typeof payload.iat === "number" && payload.iat * 1000 > nowMs + skewMs) {
    throw new GatewayError("UNAUTHORIZED", "Unauthorized");
  }
  if (!audienceOk(payload, config.audience ?? [])) throw new GatewayError("UNAUTHORIZED", "Unauthorized");

  const scopes = scopesFromClaims(payload);
  if ((requiredScopes ?? []).length > 0 && !requiredScopes.some((scope) => scopes.includes(scope))) {
    throw new GatewayError("ACCESS_DENIED", "Forbidden");
  }
  return {
    claims: payload,
    scopes,
    principalId: typeof payload.sub === "string" ? payload.sub : "",
    raw: { header, payload },
  };
}

/**
 * Reads scopes from claims: `scope` (space-delimited) and/or `scp` (array).
 *
 * @param {object} claims
 * @returns {Array<string>}
 */
export function scopesFromClaims(claims = {}) {
  const out = new Set();
  if (typeof claims.scope === "string") {
    for (const scope of claims.scope.split(" ").map((entry) => entry.trim()).filter(Boolean)) out.add(scope);
  }
  if (Array.isArray(claims.scp)) {
    for (const scope of claims.scp) {
      if (typeof scope === "string" && scope.trim() !== "") out.add(scope.trim());
    }
  }
  return [...out];
}

/**
 * Stringifies non-string claim values for `$context.authorizer.claims`, as AWS does.
 *
 * @param {object} claims
 * @returns {Record<string, string>}
 */
export function claimsForContext(claims = {}) {
  const out = {};
  for (const [key, value] of Object.entries(claims ?? {})) {
    out[key] = typeof value === "string" ? value : JSON.stringify(value);
  }
  return out;
}
