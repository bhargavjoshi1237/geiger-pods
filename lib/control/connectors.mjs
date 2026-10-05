// Private-connector management service (S04 §4): connectors, agent health,
// and token lifecycle. Tokens are shown once (`pods_ctr_` + 32 base62 chars);
// only the sha256 hash is stored. Up to 5 active tokens per connector.

import { createHash, randomBytes } from "node:crypto";
import { v, validate } from "./validate.mjs";
import { HttpError } from "./errors.mjs";
import { requirePermission } from "./authz.mjs";
import { audit } from "./audit.mjs";

export const CONNECTOR_TOKEN_PREFIX = "pods_ctr_";
export const MAX_ACTIVE_TOKENS = 5;

const BASE62 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

const CREATE_SCHEMA = v.object({
  name: v.string({ min: 1, max: 128 }),
  allowedTargets: v.optional(v.array(v.string({ min: 1, max: 256 }), { max: 200 })),
  description: v.optional(v.string({ max: 1024 })),
});

const PATCH_SCHEMA = v.object({
  name: v.optional(v.string({ min: 1, max: 128 })),
  allowedTargets: v.optional(v.array(v.string({ min: 1, max: 256 }), { max: 200 })),
  description: v.optional(v.string({ max: 1024 })),
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

/** sha256 hex of a connector token (what is stored). */
export function hashConnectorToken(token) {
  return createHash("sha256").update(String(token), "utf8").digest("hex");
}

function randomTokenSecret() {
  const bytes = randomBytes(32);
  let out = "";
  for (const byte of bytes) out += BASE62[byte % 62];
  return out;
}

export function formatConnectorToken(secret) {
  return `${CONNECTOR_TOKEN_PREFIX}${secret}`;
}

function validateTargets(targets) {
  for (const entry of targets ?? []) {
    const match = String(entry).trim().match(/^(.*):(\*|\d{1,5})$/);
    if (!match) {
      throw new HttpError(422, "invalid_input", `allowedTargets entry "${entry}" must be host:port or CIDR:port.`);
    }
    if (match[2] !== "*" && Number(match[2]) > 65535) {
      throw new HttpError(422, "invalid_input", `allowedTargets entry "${entry}" has an invalid port (0–65535 or *).`);
    }
  }
}

function connectorView(row, extra = {}) {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    status: row.status,
    statusMessage: row.status_message ?? null,
    allowedTargets: row.allowed_targets ?? [],
    agentCount: row.agent_count ?? extra.agentCount ?? 0,
    lastSeenAt: row.last_seen_at ?? null,
    description: row.description ?? null,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function tokenView(row) {
  return {
    id: row.id,
    connectorId: row.connector_id,
    prefix: row.prefix,
    createdAt: row.created_at,
    revokedAt: row.revoked_at ?? null,
  };
}

async function scopedConnector(db, projectId, connectorId) {
  const row = await db.getConnectorById(connectorId);
  if (!row || row.project_id !== projectId || row.deleted_at) {
    throw new HttpError(404, "not_found", "Connector does not exist.");
  }
  return row;
}

/** List connectors in a project. Supports `?tag:Key=Value` filters (F26). */
export async function listConnectors(db, actor, { projectId, limit = 25, cursor = null, tagFilters = [] }) {
  await requirePermission(db, actor, "pods.connector.write", { projectId });
  const take = Math.min(Math.max(Number(limit) || 25, 1), 100);
  const rows = await db.listConnectors({ projectId, limit: take + 1, cursor: cursor ? decodeCursor(cursor) : null });
  if (!tagFilters || tagFilters.length === 0) {
    const items = rows.slice(0, take).map((row) => connectorView(row));
    return { items, nextCursor: rows.length > take ? encodeCursor(rows[take - 1]) : null };
  }
  const { matchesTagFilters, resolveResourceTags } = await import("./tags.mjs");
  const kept = [];
  for (const row of rows) {
    const tags = await resolveResourceTags(db, { projectId, resourceType: "connector", resourceId: row.id, rowTags: row.tags });
    if (matchesTagFilters(tags, tagFilters)) kept.push(row);
  }
  const items = kept.slice(0, take).map((row) => connectorView(row));
  const nextCursor = kept.length > take
    ? encodeCursor(kept[take - 1])
    : rows.length > take
      ? encodeCursor(rows[take - 1])
      : null;
  return { items, nextCursor };
}

/** Create a connector (starts PENDING until an agent dials in). */
export async function createConnector(db, actor, { projectId, input, requestId = null }) {
  await requirePermission(db, actor, "pods.connector.write", { projectId });
  const clean = validate(CREATE_SCHEMA, input ?? {});
  validateTargets(clean.allowedTargets);
  const row = await db.insertConnector({
    project_id: projectId,
    name: clean.name,
    description: clean.description ?? null,
    allowed_targets: clean.allowedTargets ?? [],
    status: "PENDING",
    status_message: "Waiting for the first agent to connect.",
    created_by: actor?.userId ?? null,
  });
  const view = connectorView(row);
  await audit(db, actor, {
    action: "connector.create", resourceType: "connector", resourceId: row.id,
    projectId, before: null, after: view, requestId,
  });
  return { status: 201, body: view };
}

/** Get one connector. */
export async function getConnector(db, actor, { projectId, connectorId }) {
  await requirePermission(db, actor, "pods.connector.write", { projectId });
  return connectorView(await scopedConnector(db, projectId, connectorId));
}

/** Rename / retarget a connector. */
export async function updateConnector(db, actor, { projectId, connectorId, patch, expectedVersion = null, requestId = null }) {
  await requirePermission(db, actor, "pods.connector.write", { projectId });
  if (!patch || typeof patch !== "object" || Array.isArray(patch) || Object.keys(patch).length === 0) {
    throw new HttpError(422, "invalid_input", "Provide at least one field to update.");
  }
  const clean = validate(PATCH_SCHEMA, patch ?? {});
  validateTargets(clean.allowedTargets);
  const current = await scopedConnector(db, projectId, connectorId);
  if (expectedVersion !== null && current.version !== expectedVersion) {
    throw new HttpError(409, "version_conflict", `Connector changed (expected version ${expectedVersion}, found ${current.version}).`);
  }
  const before = connectorView(current);
  const updated = await db.updateConnector(current.id, {
    ...(clean.name !== undefined ? { name: clean.name } : {}),
    ...(clean.description !== undefined ? { description: clean.description } : {}),
    ...(clean.allowedTargets !== undefined ? { allowed_targets: clean.allowedTargets } : {}),
  });
  const after = connectorView(updated);
  await audit(db, actor, {
    action: "connector.update", resourceType: "connector", resourceId: current.id,
    projectId, before, after, requestId,
  });
  return after;
}

/** Delete a connector: mark DELETING, revoke tokens, remove the row. */
export async function deleteConnector(db, actor, { projectId, connectorId, requestId = null }) {
  await requirePermission(db, actor, "pods.connector.write", { projectId });
  const current = await scopedConnector(db, projectId, connectorId);
  const before = connectorView(current);
  await db.updateConnector(current.id, { status: "DELETING", status_message: "Connector is being removed." });
  for (const token of await db.listConnectorTokens(current.id)) {
    if (!token.revoked_at) await db.updateConnectorToken(token.id, { revoked_at: new Date().toISOString() });
  }
  await db.deleteConnector(current.id);
  await audit(db, actor, {
    action: "connector.delete", resourceType: "connector", resourceId: current.id,
    projectId, before, after: null, requestId,
  });
  return { id: current.id, deleted: true };
}

/**
 * Runtime heartbeat from the gateway (S05): agent count + derived status.
 * Service-role only: the gateway runtime calls this with its service client
 * (`{ serviceRole: true }`). It is never wired to a user-facing management
 * route, and direct calls without the service marker are rejected so a
 * compromised user credential cannot spoof connector health.
 */
export async function recordHeartbeat(db, { connectorId, agentCount, status, statusMessage = null }, options = {}) {
  if (options?.serviceRole !== true) {
    throw new HttpError(403, "forbidden", "Connector heartbeats require the service role.");
  }
  const row = await db.getConnectorById(connectorId);
  if (!row) throw new HttpError(404, "not_found", "Connector does not exist.");
  return connectorView(await db.updateConnector(connectorId, {
    agent_count: agentCount,
    status,
    status_message: statusMessage,
    last_seen_at: new Date().toISOString(),
  }));
}

/** List token metadata for a connector (hashes never leave the database). */
export async function listConnectorTokens(db, actor, { projectId, connectorId }) {
  await requirePermission(db, actor, "pods.connector.write", { projectId });
  await scopedConnector(db, projectId, connectorId);
  return { items: (await db.listConnectorTokens(connectorId)).map(tokenView) };
}

/** Create a token. The plaintext is returned once and never stored. */
export async function createConnectorToken(db, actor, { projectId, connectorId, requestId = null }) {
  await requirePermission(db, actor, "pods.connector.write", { projectId });
  await scopedConnector(db, projectId, connectorId);
  const active = (await db.listConnectorTokens(connectorId)).filter((token) => !token.revoked_at);
  if (active.length >= MAX_ACTIVE_TOKENS) {
    throw new HttpError(409, "conflict", `At most ${MAX_ACTIVE_TOKENS} active tokens per connector; revoke one first.`);
  }
  const secret = randomTokenSecret();
  const token = formatConnectorToken(secret);
  const row = await db.insertConnectorToken({
    connector_id: connectorId,
    token_hash: hashConnectorToken(token),
    prefix: token.slice(0, CONNECTOR_TOKEN_PREFIX.length + 8),
    created_by: actor?.userId ?? null,
  });
  await audit(db, actor, {
    action: "connector_token.create", resourceType: "connector_token", resourceId: row.id,
    projectId, before: null, after: tokenView(row), requestId,
  });
  return { status: 201, body: { ...tokenView(row), token } };
}

/** Revoke a token (agents using it are dropped on next heartbeat). */
export async function revokeConnectorToken(db, actor, { projectId, connectorId, tokenId, requestId = null }) {
  await requirePermission(db, actor, "pods.connector.write", { projectId });
  await scopedConnector(db, projectId, connectorId);
  const row = await db.getConnectorTokenById(tokenId);
  if (!row || row.connector_id !== connectorId) {
    throw new HttpError(404, "not_found", "Connector token does not exist.");
  }
  if (!row.revoked_at) {
    await db.updateConnectorToken(row.id, { revoked_at: new Date().toISOString() });
  }
  const after = tokenView({ ...row, revoked_at: row.revoked_at ?? new Date().toISOString() });
  await audit(db, actor, {
    action: "connector_token.revoke", resourceType: "connector_token", resourceId: row.id,
    projectId, before: tokenView(row), after, requestId,
  });
  return { ...after, revoked: true };
}

/** Rotate: revoke one token and issue its replacement (still shown once). */
export async function rotateConnectorToken(db, actor, { projectId, connectorId, tokenId, requestId = null }) {
  const revoked = await revokeConnectorToken(db, actor, { projectId, connectorId, tokenId, requestId });
  const created = await createConnectorToken(db, actor, { projectId, connectorId, requestId });
  return { status: 201, body: { revoked, created: created.body } };
}

/**
 * Verifies a presented token against stored hashes (gateway runtime path).
 * Uses a hash lookup, so timing comparison is unnecessary.
 *
 * @returns the token row + connector id, or null.
 */
export async function verifyConnectorToken(db, token) {
  if (typeof token !== "string" || !token.startsWith(CONNECTOR_TOKEN_PREFIX)) return null;
  return db.getConnectorTokenByHash(hashConnectorToken(token)) ?? null;
}
