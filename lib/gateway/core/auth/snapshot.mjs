/**
 * Authorization snapshot for the S05 compile step (S07 §3, §7).
 *
 * The control plane stores authorizers, signing credentials and the resource
 * policy as mutable draft rows; `compile()` snapshots them into the
 * immutable deployment artifact, so edits take effect on the next deployment
 * (AWS semantics). `validateAuthSnapshot` is the `validateProcessing`-style
 * hook S05 calls: it validates the draft auth config, returns normalized
 * artifact fragments plus `{ errors, warnings }`, and never carries secret
 * plaintext (credential secrets stay behind `secret:` refs resolved at
 * request time through `ports.secrets`).
 *
 * @module lib/gateway/core/auth/snapshot
 */

import { supports } from "../../capabilities.mjs";
import { snapshotResourcePolicy, MAX_RESOURCE_POLICY_CHARS } from "./resource-policy.mjs";

const AUTH_TYPES = new Set(["NONE", "SIGNED", "JWT", "CUSTOM"]);
const AUTHORIZER_TYPES = new Set(["JWT", "TOKEN", "REQUEST"]);

const IDENTITY_EXPR = /^(method\.request\.(header|querystring|path)\.[A-Za-z0-9._-]+|\$request\.(header|querystring)\.[A-Za-z0-9._-]+|\$stageVariables\.[A-Za-z0-9._-]+|\$context\.[A-Za-z0-9._-]+)$/;

/**
 * Validates one authorizer row.
 *
 * @param {object} entry - Draft authorizer (DB snake_case or camelCase).
 * @param {string} protocol
 * @returns {{ clean: object|null, errors: Array<object> }}
 */
export function validateAuthorizerRow(entry, protocol) {
  const errors = [];
  const fail = (path, message, code = "invalid_config") => errors.push({ path, message, code });
  const field = (...names) => {
    for (const name of names) {
      if (entry && Object.hasOwn(entry, name) && entry[name] !== undefined) return entry[name];
    }
    return undefined;
  };
  const id = String(field("id") ?? "");
  const prefix = `authorizers[${id || "?"}]`;
  if (!id) fail("authorizers", "Authorizer is missing an id.", "invalid_config");
  const type = field("type");
  if (!AUTHORIZER_TYPES.has(type)) {
    fail(prefix, `Unknown authorizer type "${type}".`, "invalid_config");
    return { clean: null, errors };
  }
  const identitySource = field("identitySource", "identity_source") ?? (type === "REQUEST" ? [] : ["method.request.header.Authorization"]);
  if (!Array.isArray(identitySource)) {
    fail(`${prefix}.identitySource`, "identitySource must be an array of expressions.", "invalid_config");
  } else {
    if (type === "TOKEN" && identitySource.length !== 1) {
      fail(`${prefix}.identitySource`, "TOKEN authorizers need exactly one identity source.", "invalid_config");
    }
    for (const expression of identitySource) {
      if (typeof expression !== "string" || !IDENTITY_EXPR.test(expression)) {
        fail(`${prefix}.identitySource`, `Unsupported identity source "${expression}".`, "invalid_config");
      }
    }
  }
  const jwt = field("jwt") ?? null;
  if (type === "JWT") {
    if (!jwt || typeof jwt !== "object") {
      fail(`${prefix}.jwt`, "JWT authorizers need a jwt config (issuer, audience).", "invalid_config");
    } else {
      if (typeof jwt.issuer !== "string" || jwt.issuer === "") {
        fail(`${prefix}.jwt.issuer`, "JWT issuer must be a non-empty string.", "invalid_config");
      }
      if (jwt.audience !== undefined && (!Array.isArray(jwt.audience) || jwt.audience.length > 50)) {
        fail(`${prefix}.jwt.audience`, "JWT audience must be an array of at most 50 entries.", "invalid_config");
      }
      const algorithms = jwt.algorithms ?? ["RS256"];
      if (!Array.isArray(algorithms) || algorithms.length === 0 || algorithms.some((alg) => typeof alg !== "string" || alg.toLowerCase() === "none" || /^HS/i.test(alg))) {
        fail(`${prefix}.jwt.algorithms`, "JWT algorithms must be a non-empty list (never none or HS*).", "invalid_config");
      }
    }
    if (protocol === "WEBSOCKET") {
      fail(prefix, "JWT authorizers are not supported for WEBSOCKET APIs.", "capability_unsupported");
    }
  }
  const fn = field("function") ?? null;
  if ((type === "TOKEN" || type === "REQUEST") && (!fn || typeof fn !== "object")) {
    fail(`${prefix}.function`, "Custom authorizers need a function target.", "invalid_config");
  }
  if (fn && typeof fn === "object") {
    if (fn.provider !== "webhook" && fn.provider !== "aws_lambda") {
      fail(`${prefix}.function.provider`, "Function provider must be webhook or aws_lambda.", "invalid_config");
    }
    for (const key of ["secretRef", "credentialsRef"]) {
      if (fn[key] !== undefined && fn[key] !== null && (typeof fn[key] !== "string" || !fn[key].startsWith("secret:"))) {
        fail(`${prefix}.function.${key}`, `${key} must reference a secret (secret:<id>).`, "invalid_secret_ref");
      }
    }
  }
  const credentialsRef = field("credentialsRef", "credentials_ref") ?? null;
  if (credentialsRef !== null && (typeof credentialsRef !== "string" || !credentialsRef.startsWith("secret:"))) {
    fail(`${prefix}.credentialsRef`, "credentialsRef must reference a secret (secret:<id>).", "invalid_secret_ref");
  }
  const ttl = field("resultTtlSeconds", "result_ttl_seconds") ?? (protocol === "HTTP" ? 0 : 300);
  if (!Number.isInteger(ttl) || ttl < 0 || ttl > 3600) {
    fail(`${prefix}.resultTtlSeconds`, "resultTtlSeconds must be an integer 0–3600.", "invalid_config");
  }
  const timeoutMs = field("timeoutMs", "timeout_ms") ?? 10000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 29000) {
    fail(`${prefix}.timeoutMs`, "timeoutMs must be an integer 1000–29000.", "invalid_config");
  }
  const payloadVersion = field("payloadFormatVersion", "payload_format_version") ?? null;
  if (payloadVersion !== null && payloadVersion !== "1.0" && payloadVersion !== "2.0") {
    fail(`${prefix}.payloadFormatVersion`, "payloadFormatVersion must be 1.0 or 2.0.", "invalid_config");
  }
  if (errors.length > 0) return { clean: null, errors };
  return {
    clean: {
      id,
      name: field("name") ?? id,
      type,
      identitySource: [...identitySource],
      identityValidationExpression: field("identityValidationExpression", "identity_validation_expression") ?? null,
      jwt: type === "JWT" ? {
        issuer: jwt.issuer,
        audience: [...(jwt.audience ?? [])],
        algorithms: [...(jwt.algorithms ?? ["RS256"])],
        clockSkewSec: jwt.clockSkewSec ?? 0,
      } : null,
      function: fn ? { ...fn } : null,
      payloadFormatVersion: payloadVersion,
      enableSimpleResponses: Boolean(field("enableSimpleResponses", "enable_simple_responses") ?? false),
      resultTtlSeconds: ttl,
      timeoutMs,
      credentialsRef,
    },
    errors,
  };
}

/**
 * Validates the draft authorization config for one API and returns the
 * normalized artifact fragments. Additive hook for S05 `compile()`:
 * merge `errors`/`warnings`, store `authorizers` + `resourcePolicy`.
 *
 * @param {{ protocol?: string, authorizers?: Array<object>|Record<string,object>, resourcePolicy?: unknown, methods?: Array<object>, routes?: Array<object> }} draft
 * @returns {{ authorizers: Record<string, object>, resourcePolicy: object|null, errors: Array<object>, warnings: Array<object> }}
 */
export function validateAuthSnapshot(draft = {}) {
  const errors = [];
  const warnings = [];
  const protocol = draft.protocol ?? "REST";
  const list = Array.isArray(draft.authorizers)
    ? draft.authorizers
    : Object.entries(draft.authorizers ?? {}).map(([id, value]) => ({ id, ...(value ?? {}) }));
  const authorizers = {};
  for (const entry of list) {
    const { clean, errors: rowErrors } = validateAuthorizerRow(entry, protocol);
    for (const error of rowErrors) errors.push(error);
    if (clean) authorizers[clean.id] = clean;
  }
  const authOf = (row) => String(row?.authorizationType ?? row?.authorization_type ?? row?.auth?.type ?? "NONE").toUpperCase();
  const checkMethod = (path, row) => {
    const type = authOf(row);
    if (!AUTH_TYPES.has(type)) {
      errors.push({ path, message: `Unknown authorization type "${type}".`, code: "invalid_config" });
      return;
    }
    if (type === "JWT" && !supports(protocol, "auth.jwt")) {
      errors.push({ path, message: `JWT authorization is not supported for ${protocol} APIs.`, code: "capability_unsupported" });
    }
    if (type === "CUSTOM" && !supports(protocol, "auth.custom")) {
      errors.push({ path, message: `CUSTOM authorization is not supported for ${protocol} APIs.`, code: "capability_unsupported" });
    }
    if (type === "SIGNED" && !supports(protocol, "auth.signed")) {
      errors.push({ path, message: `SIGNED authorization is not supported for ${protocol} APIs.`, code: "capability_unsupported" });
    }
    const scopes = row?.authorizationScopes ?? row?.authorization_scopes ?? row?.auth?.scopes ?? [];
    if (Array.isArray(scopes) && scopes.length > 0 && type !== "JWT") {
      warnings.push({ path, message: "authorizationScopes only apply to JWT authorizers.", code: "suspicious_config" });
    }
  };
  for (const method of draft.methods ?? []) checkMethod(`methods[${method?.id}]`, method);
  for (const route of draft.routes ?? []) {
    checkMethod(`routes[${route?.id}]`, route);
    if (protocol === "WEBSOCKET" && authOf(route) === "CUSTOM" && route?.routeKey !== "$connect") {
      errors.push({ path: `routes[${route?.id}]`, message: "WEBSOCKET custom authorizers only apply to $connect.", code: "capability_unsupported" });
    }
  }
  let resourcePolicy = null;
  const rawPolicy = draft.resourcePolicy ?? draft.settings?.resourcePolicy ?? null;
  if (rawPolicy !== null && rawPolicy !== undefined) {
    const serialized = typeof rawPolicy === "string" ? rawPolicy : JSON.stringify(rawPolicy);
    if (serialized.length > MAX_RESOURCE_POLICY_CHARS) {
      errors.push({ path: "settings.resourcePolicy", message: `Resource policy exceeds ${MAX_RESOURCE_POLICY_CHARS} characters serialized.`, code: "invalid_config" });
    } else {
      try {
        resourcePolicy = snapshotResourcePolicy(typeof rawPolicy === "string" ? JSON.parse(rawPolicy) : rawPolicy);
      } catch (error) {
        errors.push({ path: "settings.resourcePolicy", message: error.message, code: "invalid_config" });
      }
    }
  }
  return { authorizers, resourcePolicy, errors, warnings };
}
