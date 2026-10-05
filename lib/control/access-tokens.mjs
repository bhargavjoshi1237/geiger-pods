// Personal and service access tokens (S14 §2). Browser sessions keep using
// cookies; `Authorization: Bearer <token>` works for the CLI and automation.
//
// Token values are 32 random base62 bytes, shown exactly once. Only the
// sha256 hash is stored. Effective permission = token scopes ∩ the holder's
// current permissions, evaluated on every request — removing a user (or
// revoking the token) takes effect immediately.

import { createHash, randomBytes } from "node:crypto";
import { HttpError } from "./errors.mjs";
import { requirePermission } from "./authz.mjs";
import { audit } from "./audit.mjs";
import { PAT_PREFIX } from "./actor.mjs";
import rbacConfig from "../../geiger-rbac.config.js";

const CATALOG_KEYS = (rbacConfig?.permissions ?? []).map((entry) => entry.key);

export const SVC_PREFIX = "pods_svc_";
const TOKEN_BYTES = 32;
const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const PERSONAL_TTL_MAX_MS = 365 * 24 * 3600 * 1000;

function base62(bytes) {
  let out = "";
  for (const byte of bytes) out += ALPHABET[byte % 62];
  // 32 bytes → 32 chars holds ~190 bits; stretch deterministically to 43
  // chars (≈256 bits) via a second hash round so prefixes stay unique.
  const extra = createHash("sha256").update(bytes).digest();
  for (const byte of extra.slice(0, 11)) out += ALPHABET[byte % 62];
  return out;
}

export function hashToken(raw) {
  return createHash("sha256").update(String(raw), "utf8").digest("hex");
}

/**
 * Tests a permission key against a scope pattern. Patterns are exact keys
 * or `prefix*` (e.g. `pods.api.*`); `*` matches everything.
 *
 * @param {string} pattern
 * @param {string} key
 * @returns {boolean}
 */
export function matchesScope(pattern, key) {
  if (pattern === "*") return true;
  if (pattern.endsWith("*")) return key.startsWith(pattern.slice(0, -1));
  return pattern === key;
}

/**
 * Resolves a raw bearer value to a token actor. Returns null for unknown,
 * revoked or expired tokens. Updates last-used metadata (best effort).
 *
 * @param {object} db - Needs `getTokenByHash`, `recordTokenUse`.
 * @param {string} raw
 * @param {{ ip?: string|null }} [opts={}]
 * @returns {Promise<{ type: `token`, tokenId: string, projectId: string, userId: string|null, kind: string, scopes: Array<string>, name: string }|null>}
 */
export async function resolveToken(db, raw, opts = {}) {
  if (typeof raw !== "string") return null;
  const known = raw.startsWith(PAT_PREFIX) || raw.startsWith(SVC_PREFIX);
  if (!known) return null;
  const row = await db.getTokenByHash({ hash: hashToken(raw) });
  if (!row || row.revoked_at) return null;
  if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) return null;
  try {
    await db.recordTokenUse({ id: row.id, ip: opts.ip ?? null });
  } catch {
    // Usage telemetry must never break auth.
  }
  return {
    type: "token",
    tokenId: row.id,
    projectId: row.project_id,
    userId: row.user_id,
    kind: row.kind,
    scopes: [...(row.scopes ?? [])],
    name: row.name,
  };
}

function checkScopes(scopes) {
  if (!Array.isArray(scopes) || scopes.length === 0) {
    throw new HttpError(422, "invalid_input", "Provide at least one scope.");
  }
  for (const scope of scopes) {
    if (typeof scope !== "string" || scope.length === 0 || scope.length > 128) {
      throw new HttpError(422, "invalid_input", `Invalid scope "${scope}".`);
    }
  }
  return [...scopes];
}

/**
 * Lists the permission keys the actor currently holds in the project,
 * expanded from the catalog (used to bound service-token grants).
 *
 * @param {object} db
 * @param {object} actor
 * @param {string} projectId
 * @returns {Promise<Array<string>>}
 */
export async function expandHeldScopes(db, actor, projectId) {
  const held = [];
  for (const key of CATALOG_KEYS) {
    try {
      await requirePermission(db, actor, key, { projectId });
      held.push(key);
    } catch {
      // Not held; skip.
    }
  }
  return held;
}

/** List tokens (values never returned; only prefix hints). */
export async function listTokens(db, actor, { projectId }) {
  await requirePermission(db, actor, "pods.token.write", { projectId });
  const rows = await db.listTokens({ projectId });
  return (rows ?? []).map((row) => ({
    id: row.id, kind: row.kind, name: row.name, prefix: row.prefix,
    scopes: row.scopes ?? [], expiresAt: row.expires_at, lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at, createdAt: row.created_at, version: row.version,
  }));
}

/**
 * Create a token. Personal tokens require an expiry ≤ 1 year. Service
 * tokens require the creator to already hold every scope granted.
 * The raw value is returned exactly once.
 */
export async function createToken(db, actor, { projectId, kind, name, scopes, expiresAt = null, userId = null, requestId = null }) {
  await requirePermission(db, actor, "pods.token.write", { projectId });
  if (kind !== "personal" && kind !== "service") {
    throw new HttpError(422, "invalid_input", 'kind must be "personal" or "service".');
  }
  if (typeof name !== "string" || name.length < 1 || name.length > 128) {
    throw new HttpError(422, "invalid_input", "name must be 1–128 characters.");
  }
  const clean = checkScopes(scopes);
  let boundUser = null;
  if (kind === "personal") {
    boundUser = userId ?? actor.userId ?? null;
    if (!boundUser) throw new HttpError(422, "invalid_input", "Personal tokens bind to a user.");
    if (!expiresAt) throw new HttpError(422, "invalid_input", "Personal tokens require expiresAt (≤ 1 year).");
    const expiresMs = new Date(expiresAt).getTime();
    if (!Number.isFinite(expiresMs) || expiresMs <= Date.now() || expiresMs - Date.now() > PERSONAL_TTL_MAX_MS) {
      throw new HttpError(422, "invalid_input", "expiresAt must be in the future and within 1 year.");
    }
  } else {
    // Service tokens carry only scopes the creator already holds: expand
    // each pattern against the permission catalog and require every match.
    const held = await expandHeldScopes(db, actor, projectId);
    for (const scope of clean) {
      const covered = held.some((key) => matchesScope(scope, key));
      if (!covered) {
        throw new HttpError(403, "forbidden", `Cannot grant scope "${scope}" not held by the creator.`);
      }
      // The creator must actually hold something the pattern grants.
      const grantsAnything = CATALOG_KEYS.some((key) => matchesScope(scope, key) && held.includes(key));
      if (!grantsAnything) {
        throw new HttpError(403, "forbidden", `Cannot grant scope "${scope}" not held by the creator.`);
      }
    }
    if (expiresAt !== null && expiresAt !== undefined) {
      const expiresMs = new Date(expiresAt).getTime();
      if (!Number.isFinite(expiresMs) || expiresMs <= Date.now()) {
        throw new HttpError(422, "invalid_input", "expiresAt must be in the future.");
      }
    }
  }
  const raw = `${kind === "personal" ? PAT_PREFIX : SVC_PREFIX}${base62(randomBytes(TOKEN_BYTES))}`;
  const row = await db.insertToken({
    project_id: projectId,
    kind,
    user_id: boundUser,
    name,
    prefix: raw.slice(0, (kind === "personal" ? PAT_PREFIX : SVC_PREFIX).length + 6),
    token_hash: hashToken(raw),
    scopes: clean,
    expires_at: expiresAt ? new Date(expiresAt).toISOString() : null,
    created_by: actor.userId ?? null,
  });
  await audit(db, actor, {
    action: "token.create", resourceType: "access_token", resourceId: row.id,
    projectId, before: null,
    after: { id: row.id, kind, name, scopes: clean, prefix: row.prefix }, requestId,
  });
  return { id: row.id, token: raw, prefix: row.prefix };
}

/** Revoke a token (immediate). */
export async function revokeToken(db, actor, { projectId, tokenId, requestId = null }) {
  await requirePermission(db, actor, "pods.token.write", { projectId });
  const existing = await db.getTokenById({ id: tokenId });
  if (!existing || existing.project_id !== projectId) {
    throw new HttpError(404, "not_found", "Token does not exist.");
  }
  await db.revokeToken({ id: tokenId });
  await audit(db, actor, {
    action: "token.revoke", resourceType: "access_token", resourceId: tokenId,
    projectId, before: { id: tokenId, name: existing.name }, after: null, requestId,
  });
  return { id: tokenId, revoked: true };
}
