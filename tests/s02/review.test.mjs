import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { loadVaultKeys } from "../../lib/vault/keys.mjs";
import { createSecret as vaultCreateSecret, rotateSecret as vaultRotateSecret } from "../../lib/vault/secrets.mjs";
import { createSecretService, updateSecret } from "../../lib/control/secrets.mjs";
import { v, validate } from "../../lib/control/validate.mjs";
import { redact } from "../../lib/control/audit.mjs";
import { HttpError } from "../../lib/control/errors.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const KEYS = loadVaultKeys({
  PODS_VAULT_KEYS: JSON.stringify({ k1: randomBytes(32).toString("base64") }),
  PODS_VAULT_ACTIVE_KID: "k1",
});
const PROJECT = "44444444-4444-4444-8444-444444444444";
const ADMIN = { type: "user", userId: "u-admin" };

// Minimal control-db fake with real version tracking on the secrets row.
function fakeControlDb() {
  const secrets = new Map();
  const versions = new Map();
  const db = {
    async getInheritedRole({ userId }) {
      return userId === "u-admin" ? "admin" : null;
    },
    async listRoleBindings() {
      return { roles: [], grants: [] };
    },
    async insertAudit() {},
    async insertSecret(row) {
      const secret = { id: randomUUID(), version: 1, current_version: 1, deleted_at: null, ...row };
      secrets.set(secret.id, secret);
      return secret;
    },
    async getSecretById(id) {
      return secrets.get(id) ?? null;
    },
    async updateSecret(id, patch) {
      Object.assign(secrets.get(id), patch);
      return secrets.get(id);
    },
    async insertSecretVersion(row) {
      const record = { created_at: new Date().toISOString(), disabled_at: null, ...row };
      versions.set(`${row.secret_id}@${row.version}`, record);
      return record;
    },
    async getSecretVersion(secretId, version) {
      return versions.get(`${secretId}@${version}`) ?? null;
    },
    async getSecretVersionEnvelope(secretId, version) {
      return versions.get(`${secretId}@${version}`) ?? null;
    },
    async listSecretVersions(secretId) {
      return [...versions.values()].filter((row) => row.secret_id === secretId);
    },
    async updateSecretVersion(secretId, version, patch) {
      Object.assign(versions.get(`${secretId}@${version}`), patch);
      return versions.get(`${secretId}@${version}`);
    },
    async listSecrets() {
      return [];
    },
    async countSecretReferences() {
      return 0;
    },
  };
  return db;
}

test("S02 review: stale If-Match on secret PATCH conflicts after the row changed", async () => {
  const db = fakeControlDb();
  const created = await createSecretService(db, ADMIN, {
    projectId: PROJECT, name: "rotate-me", kind: "bearer", value: { token: "tok-1" },
  }, { keys: KEYS });
  const id = created.body.id;
  const first = await updateSecret(db, ADMIN, {
    projectId: PROJECT, secretId: id, patch: { description: "v2" }, expectedVersion: 1,
  });
  assert.equal(first.version, 2, "first guarded write must bump the metadata version");
  await assert.rejects(
    updateSecret(db, ADMIN, {
      projectId: PROJECT, secretId: id, patch: { description: "stale" }, expectedVersion: 1,
    }),
    (error) => error instanceof HttpError && error.status === 409 && error.code === "version_conflict",
  );
});

test("S02 review: rotating a secret bumps the metadata version so PATCH guards stay sound", async () => {
  const db = fakeControlDb();
  const created = await vaultCreateSecret(db, ADMIN, {
    projectId: PROJECT, name: "rot", kind: "bearer", value: { token: "tok-1" },
  }, { keys: KEYS });
  assert.equal(created.version, 1);
  const rotated = await vaultRotateSecret(db, ADMIN, {
    secretId: created.id, value: { token: "tok-2" },
  }, { keys: KEYS });
  assert.equal(rotated.currentVersion, 2);
  assert.equal(rotated.version, 2, "rotate mutates the row, so the optimistic-concurrency version must advance");
});

test("S02 review: secret expiresAt rejects non-date strings with 422", async () => {
  const db = fakeControlDb();
  await assert.rejects(
    createSecretService(db, ADMIN, {
      projectId: PROJECT, name: "exp", kind: "bearer", value: { token: "tok-1" }, expiresAt: "not-a-date",
    }, { keys: KEYS }),
    (error) => error instanceof HttpError && error.status === 422 && error.code === "invalid_input",
  );
  const ok = await createSecretService(db, ADMIN, {
    projectId: PROJECT, name: "exp-ok", kind: "bearer", value: { token: "tok-1" }, expiresAt: "2027-01-01T00:00:00.000Z",
  }, { keys: KEYS });
  assert.equal(ok.body.name, "exp-ok");
});

test("S02 review: pods.grant_role SQL requires pods.role.grant", () => {
  const migration = readFileSync(
    join(ROOT, "supabase", "migrations", "foundation", "20261006000102_authz_functions.sql"),
    "utf8",
  );
  const start = migration.indexOf("create or replace function pods.grant_role(");
  const end = migration.indexOf("$$;", start);
  assert.ok(start !== -1 && end !== -1, "grant_role function body not found");
  const body = migration.slice(start, end);
  assert.match(body, /pods\.can\('pods\.role\.grant'/, "grant_role must enforce the pods.role.grant permission like revoke_grant does");
});

test("S02 review: validate rejects __proto__ as an unknown field instead of dropping it silently", () => {
  const schema = v.object({ name: v.string({ min: 1, max: 64 }) });
  assert.throws(
    () => validate(schema, JSON.parse('{"name": "api", "__proto__": {"polluted": true}}')),
    (error) => error instanceof HttpError && error.status === 422,
  );
  assert.equal(Object.prototype.polluted, undefined);
});

test("S02 review: audit redact keeps __proto__ as an own property without touching the prototype", () => {
  const out = redact(JSON.parse('{"__proto__": {"polluted": true}, "name": "x"}'));
  assert.equal(Object.hasOwn(out, "__proto__"), true);
  assert.equal(out.polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal(out.name, "x");
});
