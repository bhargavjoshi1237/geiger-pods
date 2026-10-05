/**
 * Models control-plane service (S06 §1, AWS Models equivalent).
 *
 * `pods.models`: per-API named JSON Schema draft-04 documents. Writes need
 * `pods.model.write` (API-scoped); reads need `pods.apis.view`. Schemas are
 * compile-checked at write time (single-schema) and fully at deploy
 * (cross-model `$ref`), and the per-API 400 KB quota is enforced here.
 *
 * Storage goes through the S06 db port (`db.listModels`, `db.getModel`,
 * `db.insertModel`, `db.updateModel`, `db.deleteModel`); Supabase
 * implementations live in `lib/control/processing-db.mjs` so the S02-owned
 * `supabase-db.mjs` stays untouched.
 *
 * @module lib/control/models
 */

import AjvDraft04 from "ajv-draft-04";
import { v, validate } from "./validate.mjs";
import { HttpError } from "./errors.mjs";
import { requirePermission } from "./authz.mjs";
import { audit } from "./audit.mjs";
import { MODEL_NAME_PATTERN, totalSchemaBytes } from "../gateway/core/processing/validation.mjs";

const CREATE_SCHEMA = v.object({
  name: v.string({ min: 1, max: 128, pattern: "^[A-Za-z0-9]{1,128}$" }),
  contentType: v.optional(v.string({ min: 1, max: 256 })),
  description: v.optional(v.string({ max: 4096 })),
});

const PATCH_SCHEMA = v.object({
  contentType: v.optional(v.string({ min: 1, max: 256 })),
  description: v.optional(v.string({ max: 4096 })),
});

/** Checks one schema compiles as draft-04 (missing `$ref`s resolve at deploy). */
export function checkSchemaCompiles(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    throw new HttpError(422, "invalid_input", "Invalid request: $.schema: expected an object");
  }
  const ajv = new AjvDraft04({ allErrors: true, strict: false, validateSchema: true });
  try {
    ajv.compile(schema);
    return true;
  } catch (error) {
    if (/can't resolve reference|no schema with key/i.test(error.message)) return true;
    throw new HttpError(422, "invalid_input", `Invalid JSON Schema: ${error.message}`);
  }
}

function toView(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    apiId: row.api_id,
    name: row.name,
    contentType: row.content_type,
    schema: row.schema,
    description: row.description ?? "",
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function scoped(projectId, apiId, row) {
  if (!row || row.project_id !== projectId || String(row.api_id) !== String(apiId)) {
    throw new HttpError(404, "not_found", "Model does not exist.");
  }
  return row;
}

async function enforceSchemaQuota(db, { projectId, apiId }, candidate) {
  const existing = await db.listModels({ projectId, apiId });
  const others = existing.filter((row) => row.id !== candidate?.id);
  const total = totalSchemaBytes([...others.map((row) => ({ schema: row.schema })), { schema: candidate.schema }]);
  if (total > 400 * 1024) {
    throw new HttpError(422, "invalid_input", "Combined model schema size exceeds 400 KB for this API.");
  }
}

/** List models for an API (newest last, cursor pagination ready). */
export async function listModels(db, actor, { projectId, apiId, limit = 25, cursor = null }) {
  await requirePermission(db, actor, "pods.apis.view", { projectId, apiId });
  const take = Math.min(Math.max(Number(limit) || 25, 1), 100);
  const items = await db.listModels({ projectId, apiId, limit: take + 1, cursor });
  const page = items.slice(0, take);
  return {
    items: page.map(toView),
    nextCursor: items.length > take ? String(page[page.length - 1].id) : null,
  };
}

/** Get one model by name. */
export async function getModel(db, actor, { projectId, apiId, name }) {
  await requirePermission(db, actor, "pods.apis.view", { projectId, apiId });
  return toView(scoped(projectId, apiId, await db.getModel({ projectId, apiId, name })));
}

/** Create a model; 409 on duplicate name, 422 on bad schema or quota breach. */
export async function createModel(db, actor, { projectId, apiId, input, requestId = null }) {
  await requirePermission(db, actor, "pods.model.write", { projectId, apiId });
  for (const key of Object.keys(input ?? {})) {
    if (!["name", "contentType", "description", "schema"].includes(key)) {
      throw new HttpError(422, "invalid_input", `Invalid request: $.${key}: unknown field`);
    }
  }
  const clean = validate(CREATE_SCHEMA, {
    name: input?.name,
    ...(input?.contentType !== undefined ? { contentType: input.contentType } : {}),
    ...(input?.description !== undefined ? { description: input.description } : {}),
  });
  if (!MODEL_NAME_PATTERN.test(clean.name)) {
    throw new HttpError(422, "invalid_input", "Invalid request: $.name: must match ^[A-Za-z0-9]{1,128}$");
  }
  if (input?.schema === undefined) throw new HttpError(422, "invalid_input", "Invalid request: $.schema: expected an object");
  checkSchemaCompiles(input.schema);
  if (await db.getModel({ projectId, apiId, name: clean.name })) {
    throw new HttpError(409, "conflict", `A model named "${clean.name}" already exists.`);
  }
  await enforceSchemaQuota(db, { projectId, apiId }, { schema: input.schema });
  const saved = await db.insertModel({
    project_id: projectId,
    api_id: apiId,
    name: clean.name,
    content_type: clean.contentType ?? "application/json",
    schema: input.schema,
    description: clean.description ?? "",
  });
  await audit(db, actor, {
    action: "model.create",
    resourceType: "model",
    resourceId: saved.id,
    projectId,
    apiId: String(apiId),
    after: toView(saved),
    requestId,
  });
  return toView(saved);
}

/** Patch content type / description / schema (If-Match guarded). */
export async function updateModel(db, actor, { projectId, apiId, name, patch, expectedVersion = null, requestId = null }) {
  await requirePermission(db, actor, "pods.model.write", { projectId, apiId });
  const clean = validate(PATCH_SCHEMA, patch ?? {});
  const current = scoped(projectId, apiId, await db.getModel({ projectId, apiId, name }));
  if (expectedVersion !== null && expectedVersion !== current.version) {
    throw new HttpError(409, "version_conflict", `Model changed (expected version ${expectedVersion}, found ${current.version}).`);
  }
  const nextSchema = patch && Object.hasOwn(patch, "schema") ? patch.schema : current.schema;
  if (patch && Object.hasOwn(patch, "schema")) checkSchemaCompiles(patch.schema);
  await enforceSchemaQuota(db, { projectId, apiId }, { id: current.id, schema: nextSchema });
  const saved = await db.updateModel({
    id: current.id,
    content_type: clean.contentType ?? current.content_type,
    description: clean.description ?? current.description,
    schema: nextSchema,
    version: current.version + 1,
  });
  await audit(db, actor, {
    action: "model.update",
    resourceType: "model",
    resourceId: current.id,
    projectId,
    apiId: String(apiId),
    before: toView(current),
    after: toView(saved),
    requestId,
  });
  return toView(saved);
}

/** Delete a model (If-Match guarded). */
export async function deleteModel(db, actor, { projectId, apiId, name, expectedVersion = null, requestId = null }) {
  await requirePermission(db, actor, "pods.model.write", { projectId, apiId });
  const current = scoped(projectId, apiId, await db.getModel({ projectId, apiId, name }));
  if (expectedVersion !== null && expectedVersion !== current.version) {
    throw new HttpError(409, "version_conflict", `Model changed (expected version ${expectedVersion}, found ${current.version}).`);
  }
  await db.deleteModel({ id: current.id });
  await audit(db, actor, {
    action: "model.delete",
    resourceType: "model",
    resourceId: current.id,
    projectId,
    apiId: String(apiId),
    before: toView(current),
    requestId,
  });
  return { id: current.id, deleted: true };
}

/**
 * Builds an `{contentType: modelName}` request-model table, checking every
 * named model exists (the `$default` key is allowed). Used by method editors.
 */
export async function resolveRequestModels(db, { projectId, apiId }, table) {
  const entries = Object.entries(table ?? {});
  if (entries.length === 0) return {};
  const known = new Set((await db.listModels({ projectId, apiId })).map((row) => row.name));
  for (const [, name] of entries) {
    if (!known.has(name) && !["Empty", "Error"].includes(name)) {
      throw new HttpError(422, "invalid_input", `Unknown model "${name}".`);
    }
  }
  return Object.fromEntries(entries);
}
