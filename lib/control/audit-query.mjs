/**
 * Audit-trail query service (S10 §8, CloudTrail equivalent).
 *
 * `/audit`: filter by actor, action, resource type/id, API and time. Entries
 * already carry before/after JSON diffs redacted by S02. Export CSV.
 * Retention is unlimited by default; a project setting can set it to
 * ≥ 90 days (`auditRetentionDays`, validated here).
 *
 * @module lib/control/audit-query
 */

import { HttpError } from "./errors.mjs";
import { requirePermission } from "./authz.mjs";

export const MIN_AUDIT_RETENTION_DAYS = 90;

/**
 * Queries the audit trail with S10 §8 filters (extends the S02 listing with
 * action, apiId and time bounds). Requires `pods.audit.view`.
 */
export async function queryAudit(db, actor, {
  projectId, actor: actorFilter = null, action = null, resourceType = null,
  resourceId = null, apiId = null, from = null, to = null, limit = 25, cursor = null,
} = {}) {
  await requirePermission(db, actor, "pods.audit.view", { projectId });
  const take = Math.min(Math.max(Number(limit) || 25, 1), 100);
  // Note: S02 `listAuditEvents` drops action/apiId, so S10 queries the db
  // port directly (same permission gate, full S10 §8 filter set).
  return db.listAudit({
    projectId,
    filters: {
      ...(actorFilter ? { actor: String(actorFilter) } : {}),
      ...(action ? { action: String(action) } : {}),
      ...(resourceType ? { resourceType: String(resourceType) } : {}),
      ...(resourceId ? { resourceId: String(resourceId) } : {}),
      ...(apiId ? { apiId: String(apiId) } : {}),
      ...(from ? { from: String(from) } : {}),
      ...(to ? { to: String(to) } : {}),
    },
    limit: take,
    cursor,
  });
}

function csvCell(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * Exports the filtered audit trail as CSV (already redacted by S02).
 * Requires `pods.audit.view`.
 *
 * @returns {Promise<{ csv: string, count: number }>}
 */
export async function exportAuditCsv(db, actor, { projectId, filters = {}, limit = 1000 } = {}) {
  const { items } = await queryAudit(db, actor, { projectId, ...filters, limit });
  const header = ["id", "created_at", "actor_id", "actor_type", "action", "resource_type", "resource_id", "api_id", "request_id"];
  const lines = [header.join(",")];
  for (const row of items) {
    lines.push(header.map((key) => csvCell(row[key])).join(","));
  }
  return { csv: `${lines.join("\n")}\n`, count: items.length };
}

/**
 * Validates the audit-retention project setting (≥ 90 days once set).
 *
 * @param {number|null|undefined} days
 * @returns {number|null}
 */
export function cleanAuditRetention(days) {
  if (days === null || days === undefined) return null;
  if (!Number.isInteger(days) || days < MIN_AUDIT_RETENTION_DAYS) {
    throw new HttpError(422, "invalid_input", `Invalid request: $.auditRetentionDays: must be an integer ≥ ${MIN_AUDIT_RETENTION_DAYS}`);
  }
  return days;
}
