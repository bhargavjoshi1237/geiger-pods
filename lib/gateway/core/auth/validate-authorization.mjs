/**
 * Authorization draft validation (S07).
 *
 * Used by the S05 compile step (snapshot validation) and by the control
 * plane before writing authorizer rows. Returns `{ errors, warnings }`
 * with `{ path, message, code }` entries, matching the S05/S06 shape.
 *
 * @module lib/gateway/core/auth/validate-authorization
 */

import { supports } from "../../capabilities.mjs";
import { validatePolicyDocument } from "./policy.mjs";

const AUTHORIZER_TYPES = ["JWT", "TOKEN", "REQUEST"];
const AUTH_TYPES = ["NONE", "SIGNED", "JWT", "CUSTOM"];

function field(row, ...names) {
  for (const name of names) {
    if (row && Object.hasOwn(row, name) && row[name] !== undefined) return row[name];
  }
  return undefined;
}

/**
 * Validates one authorizer entry.
 *
 * @param {object} entry - CamelCase or snake_case authorizer fields.
 * @param {string} protocol
 * @param {string} prefix - Error path prefix.
 * @returns {{ errors: Array<object>, warnings: Array<object> }}
 */
export function validateAuthorizerEntry(entry, protocol, prefix = "authorizers") {
  const errors = [];
  const warnings = [];
  const fail = (path, message, code = "invalid_config") => errors.push({ path, message, code });
  const type = field(entry, "type");
  if (!AUTHORIZER_TYPES.includes(type)) {
    fail(prefix, `Unknown authorizer type "${type}". Expected one of ${AUTHORIZER_TYPES.join(", ")}.`, "unknown_authorizer_type");
    return { errors, warnings };
  }
  if (type === "JWT" && !supports(protocol, "auth.jwt")) {
    fail(prefix, "JWT authorizers are only supported on REST and HTTP APIs.", "capability_unsupported");
  }
  if ((type === "TOKEN" || type === "REQUEST") && !supports(protocol, "auth.custom")) {
    fail(prefix, "Custom authorizers are not supported for this protocol.", "capability_unsupported");
  }
  const identitySource = field(entry, "identitySource", "identity_source") ?? [];
  if (!Array.isArray(identitySource) || identitySource.length === 0) {
    fail(`${prefix}.identitySource`, "identitySource must be a non-empty array.", "invalid_identity_source");
  } else {
    const pattern = /^(\$request\.(header|querystring)\.[A-Za-z0-9._-]+|\$stageVariables\.[A-Za-z0-9_]+|\$context\.[A-Za-z0-9._-]+|method\.request\.(header|querystring)\.[A-Za-z0-9._-]+)$/;
    for (const expression of identitySource) {
      if (typeof expression !== "string" || !pattern.test(expression)) {
        fail(`${prefix}.identitySource`, `Invalid identity source "${expression}".`, "invalid_identity_source");
      }
    }
    if (type === "TOKEN" && protocol === "REST" && identitySource.length !== 1) {
      fail(`${prefix}.identitySource`, "REST TOKEN authorizers take exactly one header identity source.", "invalid_identity_source");
    }
  }
  const ttl = field(entry, "resultTtlSeconds", "result_ttl_seconds") ?? (protocol === "HTTP" ? 0 : 300);
  if (!Number.isInteger(ttl) || ttl < 0 || ttl > 3600) {
    fail(`${prefix}.resultTtlSeconds`, "resultTtlSeconds must be an integer 0–3600.", "invalid_ttl");
  }
  const timeoutMs = field(entry, "timeoutMs", "timeout_ms") ?? 10000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 29000) {
    fail(`${prefix}.timeoutMs`, "timeoutMs must be an integer 1000–29000.", "invalid_timeout");
  }
  if (type === "JWT") {
    const jwt = field(entry, "jwt") ?? {};
    if (!jwt || typeof jwt !== "object") {
      fail(`${prefix}.jwt`, "JWT authorizers require a jwt object.", "invalid_jwt");
    } else {
      if (typeof jwt.issuer !== "string" || jwt.issuer === "") {
        fail(`${prefix}.jwt.issuer`, "jwt.issuer must be a non-empty URL.", "invalid_jwt");
      }
      const audiences = jwt.audience ?? jwt.audiences ?? [];
      if (!Array.isArray(audiences)) {
        fail(`${prefix}.jwt.audience`, "jwt.audience must be an array.", "invalid_jwt");
      } else if (audiences.length > 50) {
        fail(`${prefix}.jwt.audience`, "jwt.audience holds at most 50 entries.", "invalid_jwt");
      }
      const algorithms = jwt.algorithms ?? ["RS256"];
      if (!Array.isArray(algorithms) || algorithms.length === 0) {
        fail(`${prefix}.jwt.algorithms`, "jwt.algorithms must be a non-empty array.", "invalid_jwt");
      } else {
        for (const alg of algorithms) {
          if (alg === "none" || alg === "None" || alg === "NONE" || /^HS/i.test(String(alg))) {
            fail(`${prefix}.jwt.algorithms`, `Algorithm "${alg}" is never accepted.`, "invalid_jwt");
          }
        }
      }
    }
  } else {
    const fn = field(entry, "function") ?? null;
    if (!fn || typeof fn !== "object") {
      fail(`${prefix}.function`, "Custom authorizers require a function target.", "missing_function");
    }
    const version = field(entry, "payloadFormatVersion", "payload_format_version") ?? null;
    if (version !== null && version !== undefined && !["1.0", "2.0"].includes(String(version))) {
      fail(`${prefix}.payloadFormatVersion`, 'payloadFormatVersion must be "1.0" or "2.0".', "invalid_payload_version");
    }
  }
  return { errors, warnings };
}

/**
 * Validates the authorization section of a draft.
 *
 * @param {object} [draft={}] - S05 draft shape (protocol, settings, methods/routes, authorizers).
 * @returns {{ errors: Array<object>, warnings: Array<object> }}
 */
export function validateAuthorization(draft = {}) {
  const errors = [];
  const warnings = [];
  const protocol = draft.protocol ?? draft.api?.protocol ?? "REST";
  const list = Array.isArray(draft.authorizers)
    ? draft.authorizers
    : Object.entries(draft.authorizers ?? {}).map(([id, value]) => ({ id, ...(value ?? {}) }));
  const seen = new Set();
  for (const entry of list) {
    const id = String(entry?.id ?? "");
    const prefix = `authorizers[${id || "?"}]`;
    if (id && seen.has(id)) {
      errors.push({ path: prefix, message: `Duplicate authorizer "${id}".`, code: "duplicate_authorizer" });
      continue;
    }
    if (id) seen.add(id);
    const checked = validateAuthorizerEntry(entry, protocol, prefix);
    errors.push(...checked.errors);
    warnings.push(...checked.warnings);
  }
  const settings = draft.settings ?? draft.api ?? {};
  const resourcePolicy = settings.resourcePolicy ?? settings.resource_policy ?? null;
  if (resourcePolicy !== null && resourcePolicy !== undefined) {
    if (protocol !== "REST") {
      errors.push({ path: "settings.resourcePolicy", message: "resourcePolicy is only supported on REST APIs.", code: "capability_unsupported" });
    } else {
      try {
        const serialized = JSON.stringify(resourcePolicy);
        if (serialized.length > 8192) {
          errors.push({ path: "settings.resourcePolicy", message: "resourcePolicy must serialize to at most 8192 characters.", code: "policy_too_large" });
        }
      } catch {
        errors.push({ path: "settings.resourcePolicy", message: "resourcePolicy must be JSON-serializable.", code: "invalid_policy" });
      }
      const checked = validatePolicyDocument(resourcePolicy);
      for (const problem of checked.errors) {
        errors.push({ path: "settings.resourcePolicy", message: problem?.message ?? String(problem), code: "invalid_policy" });
      }
    }
  }
  const checkAuthRef = (authType, authorizerId, scopes, prefix) => {
    if (!AUTH_TYPES.includes(authType)) {
      errors.push({ path: prefix, message: `Unknown authorization type "${authType}".`, code: "unknown_auth_type" });
      return;
    }
    if (authType === "SIGNED" && !supports(protocol, "auth.signed")) {
      errors.push({ path: prefix, message: "SIGNED authorization is not supported for this protocol.", code: "capability_unsupported" });
    }
    if (authType === "JWT" && !supports(protocol, "auth.jwt")) {
      errors.push({ path: prefix, message: "JWT authorization is only supported on REST and HTTP APIs.", code: "capability_unsupported" });
    }
    if (authType === "CUSTOM" && !supports(protocol, "auth.custom")) {
      errors.push({ path: prefix, message: "Custom authorization is not supported for this protocol.", code: "capability_unsupported" });
    }
    if ((authType === "JWT" || authType === "CUSTOM") && !authorizerId) {
      errors.push({ path: prefix, message: `${authType} authorization requires an authorizer.`, code: "missing_authorizer" });
    }
    if (authType === "NONE" && authorizerId) {
      warnings.push({ path: prefix, message: "authorizerId is ignored when authorization is NONE.", code: "ignored_authorizer" });
    }
    if (scopes !== undefined && scopes !== null) {
      if (!Array.isArray(scopes)) {
        errors.push({ path: prefix, message: "authorizationScopes must be an array.", code: "invalid_scopes" });
      } else if (scopes.length > 0 && authType !== "JWT" && authType !== "CUSTOM") {
        warnings.push({ path: prefix, message: "authorizationScopes only apply to JWT/CUSTOM authorization.", code: "ignored_scopes" });
      }
    }
  };
  for (const method of draft.methods ?? []) {
    const id = method?.id ?? method?.methodId ?? "?";
    checkAuthRef(
      method?.authorizationType ?? method?.authorization_type ?? "NONE",
      method?.authorizerId ?? method?.authorizer_id ?? null,
      method?.authorizationScopes ?? method?.authorization_scopes,
      `methods[${id}]`,
    );
  }
  for (const route of draft.routes ?? []) {
    const id = route?.id ?? "?";
    checkAuthRef(
      route?.authorizationType ?? route?.authorization_type ?? "NONE",
      route?.authorizerId ?? route?.authorizer_id ?? null,
      route?.authorizationScopes ?? route?.authorization_scopes,
      `routes[${id}]`,
    );
  }
  return { errors, warnings };
}
