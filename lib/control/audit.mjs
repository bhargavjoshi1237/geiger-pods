// Management audit trail writer (S02 §4, CloudTrail equivalent). Values that
// look like credentials are redacted before storage, never after the fact.

import { HttpError } from "./errors.mjs";
import { requirePermission } from "./authz.mjs";

const SENSITIVE_KEY = /secret|password|token|value|privateKey|ciphertext/i;

/**
 * Deep-clone a JSON value, replacing sensitive keys with "[redacted]".
 */
export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === "object" && value !== null) {
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      if (key === "__proto__") {
        // Plain assignment would invoke the prototype setter instead of
        // storing an own property. Define it explicitly so attacker-shaped
        // keys stay data, never prototype pollution.
        Object.defineProperty(out, key, {
          value: SENSITIVE_KEY.test(key) ? "[redacted]" : redact(entry),
          enumerable: true,
          configurable: true,
          writable: true,
        });
        continue;
      }
      out[key] = SENSITIVE_KEY.test(key) ? "[redacted]" : redact(entry);
    }
    return out;
  }
  return value;
}

/**
 * Append an audit event. `db.insertAudit(row)` is the only storage call, so
 * tests fake one function and Postgres enforces append-only in production.
 */
export async function audit(db, actor, event) {
  const {
    action,
    resourceType,
    resourceId,
    projectId,
    apiId = null,
    before = null,
    after = null,
    requestId = null,
  } = event;
  await db.insertAudit({
    project_id: projectId,
    actor_id: actor?.userId ?? null,
    actor_type: actor?.type ?? "system",
    action,
    resource_type: resourceType,
    resource_id: resourceId,
    api_id: apiId,
    before: before === null ? null : redact(before),
    after: after === null ? null : redact(after),
    request_id: requestId,
    source_ip: actor?.sourceIp ?? null,
    user_agent: actor?.userAgent ?? null,
  });
}

function decodeAuditCursor(cursor) {
  try {
    const parsed = JSON.parse(Buffer.from(String(cursor), "base64url").toString("utf8"));
    if (typeof parsed.createdAt === "string" && /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+(Z|[+-][0-9]{2}:[0-9]{2})$/.test(parsed.createdAt)) return parsed;
  } catch {
    // fall through
  }
  throw new HttpError(400, "invalid_input", "Invalid pagination cursor.");
}

/**
 * List audit events (newest first). Requires pods.audit.view. Filter keys are
 * camelCase query params mapped to the snake_case columns.
 */
export async function listAuditEvents(db, actor, { projectId, filters = {}, limit = 25, cursor = null }) {
  await requirePermission(db, actor, "pods.audit.view", { projectId });
  const take = Math.min(Math.max(Number(limit) || 25, 1), 100);
  const clean = {
    ...(filters.resourceType ? { resourceType: String(filters.resourceType) } : {}),
    ...(filters.resourceId ? { resourceId: String(filters.resourceId) } : {}),
    ...(filters.actor ? { actor: String(filters.actor) } : {}),
    ...(filters.from ? { from: String(filters.from) } : {}),
    ...(filters.to ? { to: String(filters.to) } : {}),
  };
  return db.listAudit({ projectId, filters: clean, limit: take, cursor: cursor ? decodeAuditCursor(cursor) : null });
}
