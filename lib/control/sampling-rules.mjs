/**
 * Sampling rules service (S10 §5, project-level tracing sampling).
 *
 * Rules are evaluated in `priority` order; the first match wins. The default
 * rule (1 req/s reservoir + 5 %, the X-Ray default) is seeded once per
 * project. Mutations need `pods.settings.write`; reads need monitoring
 * visibility.
 *
 * @module lib/control/sampling-rules
 */

import { HttpError } from "./errors.mjs";
import { requirePermission } from "./authz.mjs";
import { defaultSamplingRules } from "../gateway/core/observe/tracing.mjs";

function toRuleView(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    priority: row.priority,
    reservoirPerSec: row.reservoir_per_sec,
    fixedRate: row.fixed_rate,
    match: row.match ?? {},
  };
}

function checkRuleInput(input = {}) {
  if (!Number.isInteger(input.priority) || input.priority < 1 || input.priority > 10000) {
    throw new HttpError(422, "invalid_input", "Invalid request: $.priority: must be an integer 1–10000");
  }
  if (!Number.isInteger(input.reservoirPerSec) || input.reservoirPerSec < 0 || input.reservoirPerSec > 1000) {
    throw new HttpError(422, "invalid_input", "Invalid request: $.reservoirPerSec: must be an integer 0–1000");
  }
  if (typeof input.fixedRate !== "number" || input.fixedRate < 0 || input.fixedRate > 1) {
    throw new HttpError(422, "invalid_input", "Invalid request: $.fixedRate: must be a number 0–1");
  }
  const match = input.match ?? {};
  if (typeof match !== "object" || match === null || Array.isArray(match)) {
    throw new HttpError(422, "invalid_input", "Invalid request: $.match: must be an object");
  }
  for (const key of ["host", "method", "path", "apiId", "stage"]) {
    if (match[key] !== undefined && typeof match[key] !== "string") {
      throw new HttpError(422, "invalid_input", `Invalid request: $.match.${key}: must be a string`);
    }
  }
  return {
    priority: input.priority,
    reservoir_per_sec: input.reservoirPerSec,
    fixed_rate: input.fixedRate,
    match,
  };
}

/** Lists sampling rules (priority order). */
export async function listSamplingRules(db, actor, { projectId }) {
  const { requireMonitoringView } = await import("./metrics.mjs");
  await requireMonitoringView(db, actor, { projectId });
  const rows = await db.listSamplingRules({ projectId });
  return { items: rows.map(toRuleView).sort((a, b) => a.priority - b.priority), nextCursor: null };
}

/** Creates a sampling rule. */
export async function createSamplingRule(db, actor, { projectId, input }) {
  await requirePermission(db, actor, "pods.settings.write", { projectId });
  const row = await db.insertSamplingRule({ project_id: projectId, ...checkRuleInput(input ?? {}) });
  return toRuleView(row);
}

/** Deletes a sampling rule. */
export async function deleteSamplingRule(db, actor, { projectId, ruleId }) {
  await requirePermission(db, actor, "pods.settings.write", { projectId });
  const rows = await db.listSamplingRules({ projectId });
  if (!rows.some((row) => row.id === ruleId)) throw new HttpError(404, "not_found", "Sampling rule does not exist.");
  await db.deleteSamplingRule({ id: ruleId });
  return { id: ruleId, deleted: true };
}

/** Seeds the default 1 req/s + 5 % rule once (no-op when rules exist). */
export async function ensureDefaultSamplingRules(db, actor, { projectId }) {
  await requirePermission(db, actor, "pods.settings.write", { projectId });
  const existing = await db.listSamplingRules({ projectId });
  if ((existing ?? []).length > 0) {
    return { items: existing.map(toRuleView), seeded: false };
  }
  const [rule] = defaultSamplingRules();
  const row = await db.insertSamplingRule({
    project_id: projectId,
    priority: rule.priority,
    reservoir_per_sec: rule.reservoirPerSec,
    fixed_rate: rule.fixedRate,
    match: rule.match ?? {},
  });
  return { items: [toRuleView(row)], seeded: true };
}
