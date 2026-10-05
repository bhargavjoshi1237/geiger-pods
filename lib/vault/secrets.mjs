// Secret lifecycle: kind validation, envelope encryption and versioning
// (S02 §5). Values are write-only: every return value is metadata, never
// plaintext. The `db` port (Supabase adapter in lib/control/supabase-db.mjs):
//   insertSecret(row) / getSecretById(id) / updateSecret(id, patch)
//   insertSecretVersion(row) / getSecretVersion(secretId, version) [metadata]
//   listSecretVersions(secretId) [metadata] / getSecretVersionEnvelope(secretId, version)
//   updateSecretVersion(secretId, version, patch)
//   countSecretReferences(secretId) → number of live configuration references

import { createHash } from "node:crypto";
import { v, validate } from "../control/validate.mjs";
import { HttpError } from "../control/errors.mjs";
import { decryptSecretValue, encryptSecretValue, VaultError } from "./crypto.mjs";
import { loadVaultKeys } from "./keys.mjs";

export { VaultError };

export const SECRET_KINDS = [
  "generic",
  "header",
  "basic_auth",
  "bearer",
  "aws_credentials",
  "client_certificate",
  "private_key",
  "oauth_client",
];

const KIND_SCHEMAS = {
  generic: v.object({ value: v.string({ min: 1, max: 8192 }) }),
  header: v.object({ name: v.string({ min: 1, max: 256 }), value: v.string({ min: 1, max: 8192 }) }),
  basic_auth: v.object({ username: v.string({ min: 1, max: 256 }), password: v.string({ min: 1, max: 8192 }) }),
  bearer: v.object({ token: v.string({ min: 1, max: 8192 }) }),
  aws_credentials: v.object({
    accessKeyId: v.string({ min: 1, max: 256 }),
    secretAccessKey: v.string({ min: 1, max: 8192 }),
    sessionToken: v.optional(v.string({ min: 1, max: 8192 })),
    region: v.optional(v.string({ min: 1, max: 64 })),
  }),
  client_certificate: v.object({
    certificatePem: v.string({ min: 1, max: 65536 }),
    privateKeyPem: v.string({ min: 1, max: 65536 }),
    passphrase: v.optional(v.string({ min: 1, max: 1024 })),
  }),
  private_key: v.object({
    pem: v.string({ min: 1, max: 65536 }),
    passphrase: v.optional(v.string({ min: 1, max: 1024 })),
  }),
  oauth_client: v.object({
    tokenUrl: v.string({ min: 1, max: 2048 }),
    clientId: v.string({ min: 1, max: 1024 }),
    clientSecret: v.string({ min: 1, max: 8192 }),
    scope: v.optional(v.string({ min: 1, max: 1024 })),
    audience: v.optional(v.string({ min: 1, max: 1024 })),
  }),
};

// Field whose last 4 characters become the fingerprint. PEM kinds use a
// SHA-256 instead (a PEM's last 4 chars are always "----").
const FINGERPRINT_FIELD = {
  generic: "value",
  header: "value",
  basic_auth: "password",
  bearer: "token",
  aws_credentials: "secretAccessKey",
  client_certificate: "certificatePem",
  private_key: "pem",
  oauth_client: "clientSecret",
};

/** Validate a secret value for its kind. Throws VaultError(INVALID_VALUE). */
export function validateSecretValue(kind, value) {
  const schema = KIND_SCHEMAS[kind];
  if (!schema) throw new VaultError("INVALID_KIND", `Unknown secret kind "${kind}".`);
  try {
    return validate(schema, value);
  } catch (error) {
    if (error instanceof HttpError) throw new VaultError("INVALID_VALUE", error.message);
    throw error;
  }
}

/** Fingerprint for list views: last 4 chars of the credential, or cert SHA-256. */
export function fingerprintFor(kind, value) {
  const field = FINGERPRINT_FIELD[kind];
  const material = field ? String(value[field] ?? "") : "";
  if (kind === "client_certificate" || kind === "private_key") {
    return createHash("sha256").update(material, "utf8").digest("hex");
  }
  return material.slice(-4);
}

/** Parse `secret:<id>` (latest enabled) or `secret:<id>@<version>`. */
export function parseSecretRef(ref) {
  const match = typeof ref === "string" ? ref.match(/^secret:([A-Za-z0-9._-]{1,128})(?:@(\d{1,9}))?$/) : null;
  if (!match) throw new VaultError("INVALID_REF", `Invalid secret reference "${ref}".`);
  return { secretId: match[1], version: match[2] === undefined ? null : Number(match[2]) };
}

export function formatSecretRef(secretId, version = null) {
  return version === null ? `secret:${secretId}` : `secret:${secretId}@${version}`;
}

function versionView(row) {
  return {
    version: row.version,
    kekId: row.kek_id,
    createdAt: row.created_at,
    disabledAt: row.disabled_at ?? null,
  };
}

/** Metadata-only view of a secret. Never contains value fields. */
export function secretDetailView(secret, versions, usedBy = 0) {
  return {
    id: secret.id,
    name: secret.name,
    kind: secret.kind,
    description: secret.description ?? null,
    fingerprint: secret.fingerprint,
    currentVersion: secret.current_version,
    lastRotatedAt: secret.last_rotated_at ?? null,
    expiresAt: secret.expires_at ?? null,
    version: secret.version,
    usedBy,
    versions: versions.map(versionView),
  };
}

export function secretListView(secret, usedBy = 0) {
  const { versions, ...rest } = secretDetailView(secret, [], usedBy);
  return rest;
}

function notFound(secretId) {
  return new VaultError("NOT_FOUND", `Secret "${secretId}" does not exist.`);
}

async function liveSecret(db, secretId) {
  const secret = await db.getSecretById(secretId);
  if (!secret || secret.deleted_at) throw notFound(secretId);
  return secret;
}

function nowIso(deps) {
  return typeof deps.clock === "function" ? deps.clock() : new Date().toISOString();
}

/** Create a secret with its first version. */
export async function createSecret(db, actor, input, deps = {}) {
  const { projectId, name, kind, value, description = null, expiresAt = null } = input;
  if (!SECRET_KINDS.includes(kind)) throw new VaultError("INVALID_KIND", `Unknown secret kind "${kind}".`);
  if (typeof name !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(name)) {
    throw new VaultError("INVALID_VALUE", "Secret name must be 1–128 chars of letters, digits, dot, dash or underscore.");
  }
  const cleanValue = validateSecretValue(kind, value);
  const keys = deps.keys ?? loadVaultKeys();
  const secret = await db.insertSecret({
    project_id: projectId,
    name,
    kind,
    description,
    expires_at: expiresAt,
    fingerprint: fingerprintFor(kind, cleanValue),
    current_version: 1,
    created_by: actor?.userId ?? null,
  });
  const envelope = encryptSecretValue({
    projectId,
    secretId: secret.id,
    version: 1,
    plaintext: Buffer.from(JSON.stringify(cleanValue), "utf8"),
    kek: keys.keys[keys.activeKid],
    kekId: keys.activeKid,
  });
  await db.insertSecretVersion({
    secret_id: secret.id,
    version: 1,
    ciphertext: envelope.ciphertext,
    iv: envelope.iv,
    auth_tag: envelope.authTag,
    wrapped_dek: envelope.wrappedDek,
    kek_id: envelope.kekId,
    created_by: actor?.userId ?? null,
  });
  const versions = await db.listSecretVersions(secret.id);
  return secretDetailView(secret, versions, await db.countSecretReferences(secret.id));
}

/** Add a new version; the old version stays resolvable until disabled. */
export async function rotateSecret(db, actor, input, deps = {}) {
  const { secretId, value } = input;
  const secret = await liveSecret(db, secretId);
  const cleanValue = validateSecretValue(secret.kind, value);
  const keys = deps.keys ?? loadVaultKeys();
  const version = secret.current_version + 1;
  const envelope = encryptSecretValue({
    projectId: secret.project_id,
    secretId: secret.id,
    version,
    plaintext: Buffer.from(JSON.stringify(cleanValue), "utf8"),
    kek: keys.keys[keys.activeKid],
    kekId: keys.activeKid,
  });
  await db.insertSecretVersion({
    secret_id: secret.id,
    version,
    ciphertext: envelope.ciphertext,
    iv: envelope.iv,
    auth_tag: envelope.authTag,
    wrapped_dek: envelope.wrappedDek,
    kek_id: envelope.kekId,
    created_by: actor?.userId ?? null,
  });
  const updated = await db.updateSecret(secret.id, {
    current_version: version,
    last_rotated_at: nowIso(deps),
    fingerprint: fingerprintFor(secret.kind, cleanValue),
    version: secret.version + 1,
  });
  const versions = await db.listSecretVersions(secret.id);
  return secretDetailView(updated, versions, await db.countSecretReferences(secret.id));
}

/** Disable one version. The current version cannot be disabled. */
export async function disableVersion(db, actor, input, deps = {}) {
  const { secretId, version } = input;
  const secret = await liveSecret(db, secretId);
  if (version === secret.current_version) {
    throw new VaultError("CONFLICT", "The current version cannot be disabled; rotate first.");
  }
  const row = await db.getSecretVersion(secret.id, version);
  if (!row) throw new VaultError("NOT_FOUND", `Version ${version} of secret "${secretId}" does not exist.`);
  await db.updateSecretVersion(secret.id, version, { disabled_at: nowIso(deps) });
  const versions = await db.listSecretVersions(secret.id);
  return secretDetailView(secret, versions, await db.countSecretReferences(secret.id));
}

/** Soft-delete. Refused while configuration rows still reference the secret. */
export async function deleteSecret(db, actor, input, deps = {}) {
  const { secretId } = input;
  const secret = await liveSecret(db, secretId);
  const usedBy = await db.countSecretReferences(secret.id);
  if (usedBy > 0) {
    throw new VaultError("IN_USE", `Secret "${secret.name}" is still referenced by ${usedBy} configuration row(s).`);
  }
  const deleted = await db.updateSecret(secret.id, { deleted_at: nowIso(deps), version: secret.version + 1 });
  const versions = await db.listSecretVersions(secret.id);
  return secretDetailView(deleted, versions, 0);
}

/**
 * Resolve a secret ref to its plaintext value (service-role path only).
 * @returns {{ kind: string, value: object, version: number }}
 */
export async function resolveSecretRef(db, ref, options = {}) {
  const { secretId, version: pinned } = parseSecretRef(ref);
  const keys = options.keys ?? loadVaultKeys();
  const secret = await db.getSecretById(secretId);
  if (!secret || secret.deleted_at) throw notFound(secretId);
  if (options.projectId && secret.project_id !== options.projectId) throw notFound(secretId);
  const versions = await db.listSecretVersions(secret.id);
  let target;
  if (pinned === null) {
    target = versions.filter((entry) => !entry.disabled_at).sort((a, b) => b.version - a.version)[0] ?? null;
    if (!target) throw new VaultError("NO_ENABLED_VERSION", `Secret "${secretId}" has no enabled version.`);
  } else {
    target = versions.find((entry) => entry.version === pinned) ?? null;
    if (!target) throw new VaultError("NOT_FOUND", `Version ${pinned} of secret "${secretId}" does not exist.`);
    if (target.disabled_at) throw new VaultError("DISABLED", `Version ${pinned} of secret "${secretId}" is disabled.`);
  }
  // Envelopes are unreadable to authenticated (column-level revoke), so the
  // service role fetches the single row after the metadata check above.
  const row = await db.getSecretVersionEnvelope(secret.id, target.version);
  if (!row) throw new VaultError("NOT_FOUND", `Version ${target.version} of secret "${secretId}" does not exist.`);
  const kek = keys.keys[row.kek_id];
  if (!kek) throw new VaultError("UNKNOWN_KEK", `Vault key "${row.kek_id}" is not configured.`);
  const plaintext = decryptSecretValue({
    projectId: secret.project_id,
    secretId: secret.id,
    version: row.version,
    kek,
    ciphertext: row.ciphertext,
    iv: row.iv,
    authTag: row.auth_tag,
    wrappedDek: row.wrapped_dek,
  });
  return { kind: secret.kind, value: JSON.parse(plaintext.toString("utf8")), version: row.version };
}
