/**
 * Signing credentials control-plane service (S07 §3, §6 — the IAM equivalent).
 *
 * `pods.signing_credentials` are project-level SigV4 credentials:
 * `access_key_id` (`PKIA` + 16 base32 uppercase chars, unique) plus a vault
 * secret holding the 40-char base62 secret access key. The secret is shown
 * **once** on create and never by GET (same show-once shape as S04 connector
 * tokens and S08 API keys). Credential status flips and policy edits need
 * `pods.secret.write`; reads need `pods.apis.view`.
 *
 * `pods.signing_policies` hold identity-policy documents (S07 §6 grammar,
 * shared evaluator in `lib/gateway/core/auth/policy.mjs`). One credential
 * holds at most 10 policies. Unknown condition keys/operators are rejected
 * at save time.
 *
 * `db` port (faked in tests, Supabase in production via `auth-db.mjs`):
 * - `listSigningCredentials({ projectId, limit, cursor })`,
 *   `getSigningCredentialById(id)`, `getSigningCredentialByKey({ accessKeyId })`,
 *   `insertSigningCredential(row)`, `updateSigningCredential({ id, patch })`,
 *   `deleteSigningCredential({ id })`
 * - `listSigningPolicies({ projectId, credentialId })`,
 *   `getSigningPolicyById(id)`, `insertSigningPolicy(row)`,
 *   `updateSigningPolicy({ id, patch })`, `deleteSigningPolicy({ id })`,
 *   `countSigningPolicies({ credentialId })`
 *
 * `deps.vault` (injectable): `{ createSecret({ projectId, name, value, actor }),
 *   revealSecret(ref), deleteSecret(ref) }`.
 *
 * @module lib/control/signing-credentials
 */

import { randomBytes, randomUUID } from "node:crypto";
import { createSecret as vaultCreate, resolveSecretRef as vaultResolve } from "../vault/secrets.mjs";
import { validatePolicyDocument } from "../gateway/core/auth/policy.mjs";
import { HttpError } from "./errors.mjs";
import { requirePermission } from "./authz.mjs";
import { audit } from "./audit.mjs";
import { vaultErrorToHttp } from "./secrets.mjs";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const BASE62 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

export const MAX_POLICIES_PER_CREDENTIAL = 10;

/**
 * Generates an access key id: `PKIA` + 16 base32 uppercase chars.
 *
 * @returns {string}
 */
export function generateAccessKeyId() {
  const bytes = randomBytes(10);
  let out = "";
  // Rejection-sample 5-bit groups out of 80 bits → 16 chars exactly.
  let acc = 0;
  let bits = 0;
  for (const byte of bytes) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5 && out.length < 16) {
      bits -= 5;
      out += BASE32[(acc >>> bits) & 31];
    }
  }
  return `PKIA${out}`;
}

/**
 * Generates a secret access key: 40 chars of base62.
 *
 * @returns {string}
 */
export function generateSecretAccessKey() {
  const bytes = randomBytes(40);
  return [...bytes].map((byte) => BASE62[byte % 62]).join("");
}

function defaultVault(db) {
  return {
    async createSecret({ projectId, name, value, actor }) {
      try {
        const created = await vaultCreate(db, actor, {
          projectId,
          name: `signing-credential-${name}`,
          kind: "generic",
          value: { value },
          description: "SigV4 secret access key (S07).",
        });
        return { ref: `secret:${created.id}` };
      } catch (error) {
        throw vaultErrorToHttp(error);
      }
    },
    async revealSecret(ref) {
      try {
        const resolved = await vaultResolve(db, ref);
        return String(resolved.value?.value ?? "");
      } catch (error) {
        throw vaultErrorToHttp(error);
      }
    },
    async deleteSecret(ref) {
      try {
        const { parseSecretRef, deleteSecret } = await import("../vault/secrets.mjs");
        const { secretId } = parseSecretRef(ref);
        await deleteSecret(db, null, { secretId }).catch(() => {});
      } catch {
        // Best-effort: the credential row is already gone.
      }
    },
  };
}

function depsOf(deps, db) {
  return { vault: deps?.vault ?? defaultVault(db) };
}

function toView(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    accessKeyId: row.access_key_id,
    status: row.status ?? "ACTIVE",
    lastUsedAt: row.last_used_at ?? null,
    expiresAt: row.expires_at ?? null,
    tags: row.tags ?? {},
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toPolicyView(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    credentialId: row.credential_id,
    name: row.name,
    document: row.document,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function encodeCursor(row) {
  return Buffer.from(JSON.stringify({ createdAt: row.created_at, id: row.id }), "utf8").toString("base64url");
}

function decodeCursor(cursor) {
  try {
    const parsed = JSON.parse(Buffer.from(String(cursor), "base64url").toString("utf8"));
    if (typeof parsed.createdAt === "string" && typeof parsed.id === "string") return parsed;
  } catch {
    // fall through
  }
  throw new HttpError(400, "invalid_input", "Invalid pagination cursor.");
}

function checkName(name) {
  if (typeof name !== "string" || name.length < 1 || name.length > 128) {
    throw new HttpError(422, "invalid_input", "Invalid request: $.name: must be a string of 1–128 characters");
  }
  return name;
}

function checkTags(tags) {
  if (tags === undefined) return undefined;
  if (typeof tags !== "object" || tags === null || Array.isArray(tags)) {
    throw new HttpError(422, "invalid_input", "Invalid request: $.tags: expected an object");
  }
  return { ...tags };
}

function checkDocument(document) {
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new HttpError(422, "invalid_input", "Invalid request: $.document: expected a policy object");
  }
  const { ok, errors } = validatePolicyDocument(document, { allowPrincipal: false });
  if (!ok) {
    throw new HttpError(422, "invalid_input", `Invalid policy: ${errors[0].path}: ${errors[0].message}`, { errors });
  }
  return document;
}

async function scopedCredential(db, projectId, credentialId) {
  const row = await db.getSigningCredentialById(credentialId);
  if (!row || row.project_id !== projectId) {
    throw new HttpError(404, "not_found", "Signing credential does not exist.");
  }
  return row;
}

async function scopedPolicy(db, projectId, credentialId, policyId) {
  const row = await db.getSigningPolicyById(policyId);
  if (!row || row.project_id !== projectId || String(row.credential_id) !== String(credentialId)) {
    throw new HttpError(404, "not_found", "Signing policy does not exist.");
  }
  return row;
}

/** List signing credentials (newest first). Never includes secret values. Supports `?tag:Key=Value` filters (F26). */
export async function listSigningCredentials(db, actor, { projectId, limit = 25, cursor = null, tagFilters = [] }) {
  await requirePermission(db, actor, "pods.apis.view", { projectId });
  const take = Math.min(Math.max(Number(limit) || 25, 1), 100);
  const rows = await db.listSigningCredentials({ projectId, limit: take + 1, cursor: cursor ? decodeCursor(cursor) : null });
  if (!tagFilters || tagFilters.length === 0) {
    const page = rows.slice(0, take);
    return {
      items: page.map(toView),
      nextCursor: rows.length > take ? encodeCursor(rows[take - 1]) : null,
    };
  }
  const { matchesTagFilters, resolveResourceTags } = await import("./tags.mjs");
  const kept = [];
  for (const row of rows) {
    const tags = await resolveResourceTags(db, { projectId, resourceType: "signing_credential", resourceId: row.id, rowTags: row.tags });
    if (matchesTagFilters(tags, tagFilters)) kept.push(row);
  }
  const page = kept.slice(0, take);
  return {
    items: page.map(toView),
    nextCursor: kept.length > take ? encodeCursor(kept[take - 1]) : rows.length > take ? encodeCursor(rows[take - 1]) : null,
  };
}

/** Get one credential. Never includes the secret value. */
export async function getSigningCredential(db, actor, { projectId, credentialId }) {
  await requirePermission(db, actor, "pods.apis.view", { projectId });
  return toView(await scopedCredential(db, projectId, credentialId));
}

/**
 * Create a credential: generate the key pair, seal the secret in the vault.
 * The response contains the secret access key **once**.
 */
export async function createSigningCredential(db, actor, { projectId, name, tags, expiresAt = null, requestId = null }, deps = {}) {
  await requirePermission(db, actor, "pods.secret.write", { projectId });
  checkName(name);
  const { vault } = depsOf(deps, db);
  const accessKeyId = generateAccessKeyId();
  const secretAccessKey = generateSecretAccessKey();
  const { ref } = await vault.createSecret({ projectId, name, value: secretAccessKey, actor });
  const row = await db.insertSigningCredential({
    id: randomUUID(),
    project_id: projectId,
    name,
    access_key_id: accessKeyId,
    secret_ref: ref,
    status: "ACTIVE",
    last_used_at: null,
    expires_at: expiresAt,
    tags: checkTags(tags) ?? {},
    created_by: actor?.userId ?? null,
  });
  await audit(db, actor, {
    action: "signing_credential.create", resourceType: "signing_credential", resourceId: row.id,
    projectId, before: null, after: toView(row), requestId,
  });
  return { status: 201, body: { ...toView(row), secretAccessKey } };
}

/** Update name/status/expiresAt/tags (compare-and-swap). */
export async function updateSigningCredential(db, actor, { projectId, credentialId, patch, expectedVersion = null, requestId = null }) {
  await requirePermission(db, actor, "pods.secret.write", { projectId });
  const current = await scopedCredential(db, projectId, credentialId);
  if (expectedVersion !== null && current.version !== expectedVersion) {
    throw new HttpError(409, "version_conflict", `Signing credential changed (expected version ${expectedVersion}, found ${current.version}).`);
  }
  if (!patch || typeof patch !== "object" || Array.isArray(patch) || Object.keys(patch).length === 0) {
    throw new HttpError(422, "invalid_input", "Provide at least one field to update.");
  }
  const allowed = new Set(["name", "status", "expiresAt", "tags"]);
  for (const key of Object.keys(patch)) {
    if (!allowed.has(key)) throw new HttpError(422, "invalid_input", `Invalid request: $.${key}: unknown field`);
  }
  const next = {};
  if (patch.name !== undefined) next.name = checkName(patch.name);
  if (patch.status !== undefined) {
    if (!["ACTIVE", "INACTIVE"].includes(patch.status)) {
      throw new HttpError(422, "invalid_input", "Invalid request: $.status: must be ACTIVE or INACTIVE");
    }
    next.status = patch.status;
  }
  if (patch.expiresAt !== undefined) {
    if (patch.expiresAt !== null && (typeof patch.expiresAt !== "string" || Number.isNaN(Date.parse(patch.expiresAt)))) {
      throw new HttpError(422, "invalid_input", "Invalid request: $.expiresAt: expected an ISO timestamp or null");
    }
    next.expires_at = patch.expiresAt;
  }
  const tags = checkTags(patch.tags);
  if (tags !== undefined) next.tags = tags;
  next.version = current.version + 1;
  const before = toView(current);
  const updated = await db.updateSigningCredential({ id: current.id, patch: next });
  await audit(db, actor, {
    action: "signing_credential.update", resourceType: "signing_credential", resourceId: current.id,
    projectId, before, after: toView(updated), requestId,
  });
  return toView(updated);
}

/** Delete a credential (vault secret removed best-effort; policies cascade). */
export async function deleteSigningCredential(db, actor, { projectId, credentialId, requestId = null }, deps = {}) {
  await requirePermission(db, actor, "pods.secret.write", { projectId });
  const current = await scopedCredential(db, projectId, credentialId);
  const { vault } = depsOf(deps, db);
  const before = toView(current);
  await db.deleteSigningCredential({ id: current.id });
  await vault.deleteSecret(current.secret_ref).catch(() => {});
  await audit(db, actor, {
    action: "signing_credential.delete", resourceType: "signing_credential", resourceId: current.id,
    projectId, before, after: null, requestId,
  });
  return { id: current.id, deleted: true };
}

/** List identity policies for a credential. */
export async function listSigningPolicies(db, actor, { projectId, credentialId }) {
  await requirePermission(db, actor, "pods.apis.view", { projectId });
  await scopedCredential(db, projectId, credentialId);
  const rows = await db.listSigningPolicies({ projectId, credentialId });
  return { items: rows.map(toPolicyView) };
}

/** Attach an identity policy (at most 10 per credential). */
export async function createSigningPolicy(db, actor, { projectId, credentialId, name, document, requestId = null }) {
  await requirePermission(db, actor, "pods.secret.write", { projectId });
  const credential = await scopedCredential(db, projectId, credentialId);
  checkName(name);
  checkDocument(document);
  const count = await db.countSigningPolicies({ credentialId: credential.id });
  if (count >= MAX_POLICIES_PER_CREDENTIAL) {
    throw new HttpError(409, "limit_exceeded", `A credential holds at most ${MAX_POLICIES_PER_CREDENTIAL} policies.`);
  }
  let row;
  try {
    row = await db.insertSigningPolicy({
      id: randomUUID(),
      project_id: projectId,
      credential_id: credential.id,
      name,
      document,
      created_by: actor?.userId ?? null,
    });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(409, "conflict", `A policy named "${name}" already exists for this credential.`);
  }
  await audit(db, actor, {
    action: "signing_policy.create", resourceType: "signing_policy", resourceId: row.id,
    projectId, before: null, after: toPolicyView(row), requestId,
  });
  return { status: 201, body: toPolicyView(row) };
}

/** Replace a policy document (compare-and-swap). */
export async function updateSigningPolicy(db, actor, { projectId, credentialId, policyId, document, expectedVersion = null, requestId = null }) {
  await requirePermission(db, actor, "pods.secret.write", { projectId });
  const current = await scopedPolicy(db, projectId, credentialId, policyId);
  if (expectedVersion !== null && current.version !== expectedVersion) {
    throw new HttpError(409, "version_conflict", `Signing policy changed (expected version ${expectedVersion}, found ${current.version}).`);
  }
  checkDocument(document);
  const before = toPolicyView(current);
  const updated = await db.updateSigningPolicy({ id: current.id, patch: { document, version: current.version + 1 } });
  await audit(db, actor, {
    action: "signing_policy.update", resourceType: "signing_policy", resourceId: current.id,
    projectId, before, after: toPolicyView(updated), requestId,
  });
  return toPolicyView(updated);
}

/** Detach a policy. */
export async function deleteSigningPolicy(db, actor, { projectId, credentialId, policyId, requestId = null }) {
  await requirePermission(db, actor, "pods.secret.write", { projectId });
  const current = await scopedPolicy(db, projectId, credentialId, policyId);
  const before = toPolicyView(current);
  await db.deleteSigningPolicy({ id: current.id });
  await audit(db, actor, {
    action: "signing_policy.delete", resourceType: "signing_policy", resourceId: current.id,
    projectId, before, after: null, requestId,
  });
  return { id: current.id, deleted: true };
}

/**
 * Builds the runtime `signingCredentials`/`signingPolicies` ports from a
 * control db + vault: `resolve(accessKeyId)` returns
 * `{ secretAccessKey, status }` (and touches `last_used_at` best-effort).
 * Expired credentials resolve as `INACTIVE`.
 *
 * @param {object} db - Control db (needs the signing-credential methods).
 * @param {{ vault?: { revealSecret(ref: string): Promise<string> } }} [deps={}]
 * @returns {{ signingCredentials: { resolve(id: string): Promise<object|null> }, signingPolicies: { list(id: string): Promise<Array<object>> } }}
 */
export function createSigningPorts(db, deps = {}) {
  const vault = deps.vault ?? defaultVault(db);
  return {
    signingCredentials: {
      async resolve(accessKeyId) {
        const row = await db.getSigningCredentialByKey({ accessKeyId });
        if (!row) return null;
        const expired = row.expires_at !== null && row.expires_at !== undefined
          && Date.parse(row.expires_at) <= Date.now();
        const status = expired ? "INACTIVE" : (row.status ?? "ACTIVE");
        let secretAccessKey;
        try {
          secretAccessKey = await vault.revealSecret(row.secret_ref);
        } catch {
          return null;
        }
        try {
          await db.updateSigningCredential({ id: row.id, patch: { last_used_at: new Date().toISOString() } });
        } catch {
          // Best-effort usage accounting; never breaks verification.
        }
        return { secretAccessKey, status };
      },
    },
    signingPolicies: {
      async list(accessKeyId) {
        const row = await db.getSigningCredentialByKey({ accessKeyId });
        if (!row) return [];
        const rows = await db.listSigningPolicies({ projectId: row.project_id, credentialId: row.id });
        return rows.map((entry) => entry.document);
      },
    },
  };
}
