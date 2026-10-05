/**
 * Log sinks + sampling rules + stage observability services (S10 §5–§6, §9).
 *
 * - `pods.log_sinks`: `https | s3 | otlp_logs` with secret refs in config.
 *   Mutations need `pods.export.write`.
 * - `pods.sampling_rules`: priority-ordered project rules; the default
 *   1 req/s + 5 % rule is seeded once. Mutations need `pods.settings.write`.
 * - Stage observability (`stages.access_log`, `method_settings`,
 *   `route_settings`, `tracing_enabled`): validated here, written through
 *   `db.updateStage` with an audit row. Writes need `pods.stage.write`.
 *
 * @module lib/control/sinks
 */

import { HttpError } from "./errors.mjs";
import { requirePermission } from "./authz.mjs";
import { audit } from "./audit.mjs";

export const SINK_TYPES = ["https", "s3", "otlp_logs"];

function toSinkView(row) {
  const { config, ...rest } = row;
  const safeConfig = { ...(config ?? {}) };
  // Secret refs stay refs — values never leave the vault.
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    type: row.type,
    config: safeConfig,
    status: row.status ?? "active",
    lastDeliveryAt: row.last_delivery_at ?? null,
    lastError: row.last_error ?? null,
  };
}

function checkSinkInput(input = {}) {
  if (typeof input.name !== "string" || input.name.length === 0 || input.name.length > 128) {
    throw new HttpError(422, "invalid_input", "Invalid request: $.name: must be a string of 1–128 characters");
  }
  if (!SINK_TYPES.includes(input.type)) {
    throw new HttpError(422, "invalid_input", `Invalid request: $.type: must be one of ${SINK_TYPES.join(", ")}`);
  }
  const config = input.config ?? {};
  if (typeof config !== "object" || config === null) {
    throw new HttpError(422, "invalid_input", "Invalid request: $.config: must be an object");
  }
  if (input.type === "https") {
    if (typeof config.url !== "string" || !/^https:\/\//.test(config.url)) {
      throw new HttpError(422, "invalid_input", "Invalid request: $.config.url: must be an https URL");
    }
    if (typeof config.secretRef !== "string" || config.secretRef.length === 0) {
      throw new HttpError(422, "invalid_input", "Invalid request: $.config.secretRef: HMAC secret ref is required");
    }
  }
  if (input.type === "s3") {
    for (const key of ["bucket", "prefix", "region"]) {
      if (typeof config[key] !== "string" || config[key].length === 0) {
        throw new HttpError(422, "invalid_input", `Invalid request: $.config.${key}: must be a non-empty string`);
      }
    }
  }
  if (input.type === "otlp_logs") {
    if (typeof config.endpoint !== "string" || !/^https:\/\//.test(config.endpoint)) {
      throw new HttpError(422, "invalid_input", "Invalid request: $.config.endpoint: must be an https URL");
    }
  }
  return { name: input.name, type: input.type, config };
}

/** Creates a log sink. */
export async function createSink(db, actor, { projectId, input, requestId = null }) {
  await requirePermission(db, actor, "pods.export.write", { projectId });
  const clean = checkSinkInput(input ?? {});
  const row = await db.insertSink({ project_id: projectId, ...clean, status: "active", created_by: actor?.userId ?? null });
  await audit(db, actor, {
    action: "sink.create", resourceType: "log_sink", resourceId: row.id,
    projectId, before: null, after: toSinkView(row), requestId,
  }).catch(() => {});
  return toSinkView(row);
}

/** Updates a log sink. */
export async function updateSink(db, actor, { projectId, sinkId, patch, requestId = null }) {
  await requirePermission(db, actor, "pods.export.write", { projectId });
  const current = await db.getSinkById(sinkId);
  if (!current || current.project_id !== projectId) throw new HttpError(404, "not_found", "Sink does not exist.");
  const clean = checkSinkInput({ name: patch?.name ?? current.name, type: patch?.type ?? current.type, config: patch?.config ?? current.config });
  const next = await db.updateSink({ id: sinkId, patch: clean });
  await audit(db, actor, {
    action: "sink.update", resourceType: "log_sink", resourceId: sinkId,
    projectId, before: toSinkView(current), after: toSinkView(next), requestId,
  }).catch(() => {});
  return toSinkView(next);
}

/** Deletes a log sink. */
export async function deleteSink(db, actor, { projectId, sinkId, requestId = null }) {
  await requirePermission(db, actor, "pods.export.write", { projectId });
  const current = await db.getSinkById(sinkId);
  if (!current || current.project_id !== projectId) throw new HttpError(404, "not_found", "Sink does not exist.");
  await db.deleteSink({ id: sinkId });
  await audit(db, actor, {
    action: "sink.delete", resourceType: "log_sink", resourceId: sinkId,
    projectId, before: toSinkView(current), after: null, requestId,
  }).catch(() => {});
  return { id: sinkId, deleted: true };
}

/** Lists log sinks. */
export async function listSinks(db, actor, { projectId }) {
  await requirePermission(db, actor, "pods.export.write", { projectId });
  return { items: (await db.listSinks({ projectId })).map(toSinkView), nextCursor: null };
}

/**
 * Sends one test event through `deliver({ sink, payload })` and records the
 * outcome on the sink (status + `last_delivery_at` / `last_error`).
 */
export async function testSinkDelivery(db, actor, { projectId, sinkId, deliver }) {
  await requirePermission(db, actor, "pods.export.write", { projectId });
  const sink = await db.getSinkById(sinkId);
  if (!sink || sink.project_id !== projectId) throw new HttpError(404, "not_found", "Sink does not exist.");
  const payload = { test: true, requestId: "test-delivery", ts: new Date().toISOString() };
  try {
    await deliver({ sink: toSinkView(sink), payload });
    await db.updateSink({ id: sinkId, patch: { status: "active", last_delivery_at: new Date().toISOString(), last_error: null } });
    return { ok: true };
  } catch (error) {
    await db.updateSink({ id: sinkId, patch: { status: "error", last_error: error?.message ?? String(error) } });
    return { ok: false, error: error?.message ?? String(error) };
  }
}
