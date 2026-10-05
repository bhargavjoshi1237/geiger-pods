/**
 * CORS control-plane service (S06 §2).
 *
 * HTTP APIs carry a managed CORS config on the API draft (`apis.cors` in
 * S03's table): `{ allowOrigins, allowMethods, allowHeaders, exposeHeaders,
 * maxAge, allowCredentials }`. Reads need `pods.apis.view`; writes need
 * `pods.api.update`. Also exports the REST "Enable CORS" draft builder —
 * the caller (S03 method services) persists the returned OPTIONS method and
 * header mappings; this module stays persistence-free for that path so the
 * control-plane test needs no S03 tables.
 *
 * Storage port: `db.getApiCors({projectId, apiId})` /
 * `db.updateApiCors({projectId, apiId, cors, version})`. Supabase
 * implementations live in `processing-db.mjs`.
 *
 * @module lib/control/cors
 */

import { HttpError } from "./errors.mjs";
import { requirePermission } from "./authz.mjs";
import { audit } from "./audit.mjs";
import { validateCorsConfig, planRestEnableCors } from "../gateway/core/processing/cors.mjs";

export { planRestEnableCors };

function checkCors(input) {
  if (input === null) return null;
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new HttpError(422, "invalid_input", "Invalid request: CORS config must be an object or null");
  }
  for (const key of Object.keys(input)) {
    if (!["allowOrigins", "allowMethods", "allowHeaders", "exposeHeaders", "maxAge", "allowCredentials"].includes(key)) {
      throw new HttpError(422, "invalid_input", `Invalid request: $.${key}: unknown field`);
    }
  }
  const config = {
    allowOrigins: input.allowOrigins ?? [],
    allowMethods: input.allowMethods ?? [],
    allowHeaders: input.allowHeaders ?? [],
    exposeHeaders: input.exposeHeaders ?? [],
    maxAge: input.maxAge ?? null,
    allowCredentials: input.allowCredentials ?? false,
  };
  const errors = validateCorsConfig(config);
  if (errors.length > 0) throw new HttpError(422, "invalid_input", errors[0], { errors });
  return config;
}

/** Reads the managed CORS config (null when unconfigured). */
export async function getCors(db, actor, { projectId, apiId }) {
  await requirePermission(db, actor, "pods.apis.view", { projectId, apiId });
  const row = await db.getApiCors({ projectId, apiId });
  if (!row) throw new HttpError(404, "not_found", "API does not exist.");
  return { apiId, cors: row.cors ?? null, version: row.version ?? 0 };
}

/** Replaces the managed CORS config (If-Match guarded). */
export async function putCors(db, actor, { projectId, apiId, input, expectedVersion = null, requestId = null }) {
  await requirePermission(db, actor, "pods.api.update", { projectId, apiId });
  const cors = checkCors(input === undefined ? null : input);
  const current = await db.getApiCors({ projectId, apiId });
  if (!current) throw new HttpError(404, "not_found", "API does not exist.");
  if (expectedVersion !== null && expectedVersion !== (current.version ?? 0)) {
    throw new HttpError(409, "version_conflict", `API changed (expected version ${expectedVersion}, found ${current.version}).`);
  }
  const saved = await db.updateApiCors({ projectId, apiId, cors, version: (current.version ?? 0) + 1 });
  await audit(db, actor, {
    action: "cors.update",
    resourceType: "api_cors",
    resourceId: String(apiId),
    projectId,
    apiId: String(apiId),
    before: { cors: current.cors ?? null },
    after: { cors: saved.cors ?? null },
    requestId,
  });
  return { apiId, cors: saved.cors ?? null, version: saved.version ?? 0 };
}

/**
 * Builds the REST "Enable CORS" draft for a resource: an OPTIONS mock
 * method plus the 200 header mappings to add to selected methods and the
 * optional DEFAULT_4XX/5XX gateway-response header additions.
 * Pure — the S03 method services persist the result.
 *
 * @param {{ allowOrigin?: string, allowMethods?: Array<string>, allowHeaders?: Array<string>, includeGatewayResponses?: boolean }} [options]
 * @returns {{ optionsMethod: object, methodResponseHeaders: object, gatewayResponseHeaders: object }}
 */
export function buildEnableCorsDraft(options = {}) {
  const plan = planRestEnableCors(options);
  return {
    optionsMethod: plan.optionsMethod,
    methodResponseHeaders: { ...plan.methodResponseHeaders },
    gatewayResponseHeaders: options.includeGatewayResponses === true ? { ...plan.gatewayResponseHeaders } : {},
  };
}
