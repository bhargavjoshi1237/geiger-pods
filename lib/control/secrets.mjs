// Secrets management service (S02 §5 + Management API table). Every operation
// requires pods.secret.write and returns metadata only — values never leave
// the vault except through resolve() on the service-role path.

import { v, validate } from "./validate.mjs";
import { HttpError } from "./errors.mjs";
import { requirePermission } from "./authz.mjs";
import { audit } from "./audit.mjs";
import {
  VaultError,
  createSecret as vaultCreate,
  deleteSecret as vaultDelete,
  disableVersion as vaultDisable,
  rotateSecret as vaultRotate,
  secretDetailView,
  secretListView,
} from "../vault/secrets.mjs";

export function vaultErrorToHttp(error) {
  if (error instanceof HttpError) return error;
  if (error instanceof VaultError) {
    switch (error.code) {
      case "NOT_FOUND":
        return new HttpError(404, "not_found", error.message);
      case "DISABLED":
      case "NO_ENABLED_VERSION":
        return new HttpError(410, "version_disabled", error.message);
      case "INVALID_KIND":
      case "INVALID_VALUE":
      case "INVALID_REF":
        return new HttpError(422, "invalid_input", error.message);
      case "CONFLICT":
      case "IN_USE":
        return new HttpError(409, "conflict", error.message);
      default:
        return new HttpError(500, "internal_error", "Internal server error");
    }
  }
  return error;
}

const CREATE_SCHEMA = v.object({
  name: v.string({ min: 1, max: 128, pattern: "^[A-Za-z0-9._-]+$" }),
  description: v.optional(v.string({ max: 1024 })),
  expiresAt: v.optional(v.string({ max: 64 })),
});

const PATCH_SCHEMA = v.object({
  description: v.optional(v.string({ max: 1024 })),
  expiresAt: v.optional(v.string({ max: 64 })),
});

function encodeCursor(row) {
  return Buffer.from(JSON.stringify({ createdAt: row.created_at, id: row.id }), "utf8").toString("base64url");
}

function decodeCursor(cursor) {
  try {
    const parsed = JSON.parse(Buffer.from(String(cursor), "base64url").toString("utf8"));
    if (typeof parsed.createdAt === "string" && /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+(Z|[+-][0-9]{2}:[0-9]{2})$/.test(parsed.createdAt) && typeof parsed.id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(parsed.id)) return parsed;
  } catch {
    // fall through
  }
  throw new HttpError(400, "invalid_input", "Invalid pagination cursor.");
}

function scoped(db, actor, projectId, secret) {
  if (!secret || secret.project_id !== projectId || secret.deleted_at) {
    throw new HttpError(404, "not_found", "Secret does not exist.");
  }
  return secret;
}

// timestamptz columns reject malformed input at the database (500), so reject
// non-date strings here with 422 per the S01 error conventions.
function assertExpiresAt(value) {
  if (value === undefined) return;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new HttpError(422, "invalid_input", "Invalid request: $.expiresAt must be a date string.");
  }
}

async function withSecretError(fn) {
  try {
    return await fn();
  } catch (error) {
    throw vaultErrorToHttp(error);
  }
}

/** List secret metadata (newest first). Cursor pagination per S01 §8. */
export async function listSecrets(db, actor, { projectId, limit = 25, cursor = null }) {
  await requirePermission(db, actor, "pods.secret.write", { projectId });
  const take = Math.min(Math.max(Number(limit) || 25, 1), 100);
  const rows = await db.listSecrets({ projectId, limit: take + 1, cursor: cursor ? decodeCursor(cursor) : null });
  const items = [];
  for (const row of rows.slice(0, take)) {
    items.push(secretListView(row, await db.countSecretReferences(row.id)));
  }
  const nextCursor = rows.length > take ? encodeCursor(rows[take - 1]) : null;
  return { items, nextCursor };
}

export async function getSecret(db, actor, { projectId, secretId }) {
  await requirePermission(db, actor, "pods.secret.write", { projectId });
  return withSecretError(async () => {
    const secret = scoped(db, actor, projectId, await db.getSecretById(secretId));
    const versions = await db.listSecretVersions(secret.id);
    return secretDetailView(secret, versions, await db.countSecretReferences(secret.id));
  });
}

export async function createSecretService(db, actor, input, deps = {}) {
  const { projectId, kind, value, requestId = null } = input;
  await requirePermission(db, actor, "pods.secret.write", { projectId });
  const clean = validate(CREATE_SCHEMA, {
    name: input.name,
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
  });
  assertExpiresAt(clean.expiresAt);
  return withSecretError(async () => {
    const created = await vaultCreate(db, actor, {
      projectId,
      name: clean.name,
      kind,
      value,
      description: clean.description ?? null,
      expiresAt: clean.expiresAt ?? null,
    }, deps);
    await audit(db, actor, {
      action: "secret.create",
      resourceType: "secret",
      resourceId: created.id,
      projectId,
      before: null,
      after: created,
      requestId,
    });
    return { status: 201, body: created };
  });
}

export async function updateSecret(db, actor, { projectId, secretId, patch, expectedVersion = null, requestId = null }) {
  await requirePermission(db, actor, "pods.secret.write", { projectId });
  if (!patch || typeof patch !== "object" || Array.isArray(patch) || Object.keys(patch).length === 0) {
    throw new HttpError(422, "invalid_input", "Provide at least one field to update.");
  }
  const clean = validate(PATCH_SCHEMA, patch ?? {});
  assertExpiresAt(clean.expiresAt);
  return withSecretError(async () => {
    const secret = scoped(db, actor, projectId, await db.getSecretById(secretId));
    if (expectedVersion !== null && secret.version !== expectedVersion) {
      throw new HttpError(409, "version_conflict", `Secret changed (expected version ${expectedVersion}, found ${secret.version}).`);
    }
    const before = secretDetailView(secret, await db.listSecretVersions(secret.id));
    const updated = await db.updateSecret(secret.id, {
      description: clean.description ?? secret.description,
      expires_at: clean.expiresAt ?? secret.expires_at,
      version: secret.version + 1,
    });
    const after = secretDetailView(updated, await db.listSecretVersions(secret.id));
    await audit(db, actor, {
      action: "secret.update", resourceType: "secret", resourceId: secret.id,
      projectId, before, after, requestId,
    });
    return after;
  });
}

export async function rotateSecretService(db, actor, { projectId, secretId, value, requestId = null }, deps = {}) {
  await requirePermission(db, actor, "pods.secret.write", { projectId });
  return withSecretError(async () => {
    scoped(db, actor, projectId, await db.getSecretById(secretId));
    const rotated = await vaultRotate(db, actor, { secretId, value }, deps);
    await audit(db, actor, {
      action: "secret.rotate", resourceType: "secret", resourceId: rotated.id,
      projectId, before: { currentVersion: rotated.currentVersion - 1 }, after: rotated, requestId,
    });
    return rotated;
  });
}

export async function disableSecretVersion(db, actor, { projectId, secretId, version, requestId = null }) {
  await requirePermission(db, actor, "pods.secret.write", { projectId });
  return withSecretError(async () => {
    scoped(db, actor, projectId, await db.getSecretById(secretId));
    const disabled = await vaultDisable(db, actor, { secretId, version });
    await audit(db, actor, {
      action: "secret.disable_version", resourceType: "secret", resourceId: disabled.id,
      projectId, before: null, after: disabled, requestId,
    });
    return disabled;
  });
}

export async function deleteSecretService(db, actor, { projectId, secretId, requestId = null }) {
  await requirePermission(db, actor, "pods.secret.write", { projectId });
  return withSecretError(async () => {
    const secret = scoped(db, actor, projectId, await db.getSecretById(secretId));
    const before = secretDetailView(secret, await db.listSecretVersions(secret.id));
    await vaultDelete(db, actor, { secretId });
    await audit(db, actor, {
      action: "secret.delete", resourceType: "secret", resourceId: secret.id,
      projectId, before, after: null, requestId,
    });
    return { id: secret.id, deleted: true };
  });
}
