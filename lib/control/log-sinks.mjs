/**
 * Log-sink service (S10 §6, Firehose equivalent).
 *
 * `pods.log_sinks`: `https` (NDJSON batches ≤ 1 MB, signed
 * `x-pods-signature`), `s3` (gzip NDJSON objects) and `otlp_logs`.
 * Stage access-log `destinations` may reference a sink id.
 * Permission: `pods.export.write`.
 *
 * @module lib/control/log-sinks
 */

import { HttpError } from "./errors.mjs";
import { requirePermission } from "./authz.mjs";
import { audit } from "./audit.mjs";
import { deliverHttpsBatch } from "../gateway/core/observe/sinks.mjs";

const SINK_TYPES = ["https", "s3", "otlp_logs"];

function cleanSinkInput(input = {}) {
  const out = {};
  if (input.name !== undefined) {
    if (typeof input.name !== "string" || input.name.length === 0 || input.name.length > 128) {
      throw new HttpError(422, "invalid_input", "Invalid request: $.name: must be a string of 1–128 characters");
    }
    out.name = input.name;
  }
  if (input.type !== undefined) {
    if (!SINK_TYPES.includes(input.type)) {
      throw new HttpError(422, "invalid_input", `Invalid request: $.type: must be one of ${SINK_TYPES.join(", ")}`);
    }
    out.type = input.type;
  }
  if (input.config !== undefined) {
    if (!input.config || typeof input.config !== "object" || Array.isArray(input.config)) {
      throw new HttpError(422, "invalid_input", "Invalid request: $.config: expected an object");
    }
    const type = input.type;
    if (type === "https" && typeof input.config.url !== "string") {
      throw new HttpError(422, "invalid_input", "Invalid request: $.config.url: is required for https sinks");
    }
    if (type === "s3" && typeof input.config.bucket !== "string") {
      throw new HttpError(422, "invalid_input", "Invalid request: $.config.bucket: is required for s3 sinks");
    }
    if (type === "otlp_logs" && typeof input.config.endpoint !== "string") {
      throw new HttpError(422, "invalid_input", "Invalid request: $.config.endpoint: is required for otlp_logs sinks");
    }
    // Secret refs (HMAC key, S3 credentials, OTLP headers) stay refs — the
    // plaintext is resolved from the vault only at delivery time.
    out.config = { ...input.config };
  }
  if (input.status !== undefined) {
    if (!["active", "error", "disabled"].includes(input.status)) {
      throw new HttpError(422, "invalid_input", "Invalid request: $.status: must be one of active, error, disabled");
    }
    out.status = input.status;
  }
  return out;
}

function toView(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    type: row.type,
    config: row.config ?? {},
    status: row.status ?? "active",
    lastDeliveryAt: row.last_delivery_at ?? null,
    lastError: row.last_error ?? null,
    version: row.version ?? 1,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
  };
}

/** Lists sinks (any member can see names/status; secrets stay refs). */
export async function listSinks(db, actor, { projectId }) {
  await requirePermission(db, actor, "pods.monitoring.view", { projectId });
  return { items: (await db.listLogSinks({ projectId })).map(toView), nextCursor: null };
}

/** Gets one sink. */
export async function getSink(db, actor, { projectId, sinkId }) {
  await requirePermission(db, actor, "pods.monitoring.view", { projectId });
  const row = await db.getLogSink({ projectId, id: sinkId });
  if (!row) throw new HttpError(404, "not_found", "Log sink does not exist.");
  return toView(row);
}

/** Creates a sink. */
export async function createSink(db, actor, { projectId, input, requestId = null }) {
  await requirePermission(db, actor, "pods.export.write", { projectId });
  const clean = cleanSinkInput(input ?? {});
  if (!clean.name || !clean.type) {
    throw new HttpError(422, "invalid_input", "Invalid request: $.name and $.type are required");
  }
  if (await db.getLogSinkByName({ projectId, name: clean.name }).catch(() => null)) {
    throw new HttpError(409, "conflict", `A sink named "${clean.name}" already exists.`);
  }
  const saved = await db.insertLogSink({ project_id: projectId, ...clean });
  await audit(db, actor, {
    action: "export.sink.create", resourceType: "log_sink", resourceId: saved.id,
    projectId, before: null, after: toView(saved), requestId,
  });
  return { status: 201, body: toView(saved) };
}

/** Patches a sink (If-Match guarded). */
export async function updateSink(db, actor, { projectId, sinkId, patch, expectedVersion = null, requestId = null }) {
  await requirePermission(db, actor, "pods.export.write", { projectId });
  const current = await db.getLogSink({ projectId, id: sinkId });
  if (!current) throw new HttpError(404, "not_found", "Log sink does not exist.");
  if (expectedVersion !== null && current.version !== expectedVersion) {
    throw new HttpError(409, "version_conflict", `Sink changed (expected version ${expectedVersion}, found ${current.version}).`);
  }
  const clean = cleanSinkInput(patch ?? {});
  const saved = await db.updateLogSink({ id: current.id, patch: { ...clean, version: (current.version ?? 1) + 1 } });
  await audit(db, actor, {
    action: "export.sink.update", resourceType: "log_sink", resourceId: current.id,
    projectId, before: toView(current), after: toView(saved), requestId,
  });
  return toView(saved);
}

/** Deletes a sink. */
export async function deleteSink(db, actor, { projectId, sinkId, requestId = null }) {
  await requirePermission(db, actor, "pods.export.write", { projectId });
  const current = await db.getLogSink({ projectId, id: sinkId });
  if (!current) throw new HttpError(404, "not_found", "Log sink does not exist.");
  await db.deleteLogSink({ id: current.id });
  await audit(db, actor, {
    action: "export.sink.delete", resourceType: "log_sink", resourceId: current.id,
    projectId, before: toView(current), after: null, requestId,
  });
  return { id: current.id, deleted: true };
}

/**
 * Sends a test NDJSON batch to an `https` sink (Export → test-delivery).
 * Records `last_delivery_at` / `last_error`. `secretResolver` resolves the
 * HMAC secret ref; `fetchImpl` is injectable for tests.
 */
export async function testSinkDelivery(db, actor, { projectId, sinkId, secretResolver = null, fetchImpl = globalThis.fetch }) {
  await requirePermission(db, actor, "pods.export.write", { projectId });
  const sink = await db.getLogSink({ projectId, id: sinkId });
  if (!sink) throw new HttpError(404, "not_found", "Log sink does not exist.");
  if (sink.type !== "https") {
    throw new HttpError(400, "unsupported_sink", "Test delivery is only available for https sinks.");
  }
  const secretRef = sink.config?.secretRef ?? sink.config?.hmacSecretRef ?? null;
  if (!secretRef) {
    throw new HttpError(422, "invalid_input", "This sink has no HMAC secret ref (config.secretRef).");
  }
  const secret = secretResolver
    ? await secretResolver.resolve(secretRef)
    : await db.resolveSecretRef(secretRef).catch(() => { throw new HttpError(422, "invalid_input", "Unknown secret ref."); });
  const rows = [{ test: true, sinkId: sink.id, ts: new Date().toISOString() }];
  try {
    const { status } = await deliverHttpsBatch({ url: sink.config.url, secret, rows, fetchImpl });
    await db.updateLogSink({ id: sink.id, patch: { last_delivery_at: new Date().toISOString(), last_error: null, status: "active" } });
    return { ok: true, status };
  } catch (error) {
    await db.updateLogSink({ id: sink.id, patch: { last_error: error.message ?? "Delivery failed.", status: "error" } });
    throw new HttpError(502, "delivery_failed", `Test delivery failed: ${error.message ?? error}`);
  }
}
