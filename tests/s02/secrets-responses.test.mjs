import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { loadVaultKeys } from "../../lib/vault/keys.mjs";
import {
  createSecretService,
  deleteSecretService,
  disableSecretVersion,
  getSecret,
  listSecrets,
  rotateSecretService,
  updateSecret,
} from "../../lib/control/secrets.mjs";

const SNAPSHOT = join(dirname(fileURLToPath(import.meta.url)), "__snapshots__", "secrets-responses.json");
const KEYS = loadVaultKeys({
  PODS_VAULT_KEYS: JSON.stringify({ k1: randomBytes(32).toString("base64") }),
  PODS_VAULT_ACTIVE_KID: "k1",
});
const PROJECT = "33333333-3333-4333-8333-333333333333";
const ADMIN = { type: "user", userId: "u-admin" };

function fakeControlDb() {
  const secrets = new Map();
  const versions = new Map();
  const db = {
    audits: [],
    async getInheritedRole({ userId }) {
      return userId === "u-admin" ? "admin" : null;
    },
    async listRoleBindings() {
      return { roles: [], grants: [] };
    },
    async insertAudit(entry) {
      db.audits.push(entry);
    },
    async insertSecret(row) {
      const secret = {
        id: randomUUID(), created_at: "2026-10-06T00:00:01.000Z", updated_at: "2026-10-06T00:00:01.000Z",
        last_rotated_at: "2026-10-06T00:00:01.000Z", deleted_at: null, expires_at: null, description: null,
        version: 1, ...row,
      };
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
      const record = { created_at: "2026-10-06T00:00:02.000Z", disabled_at: null, ...row };
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
      return [...versions.values()].filter((row) => row.secret_id === secretId).sort((a, b) => b.version - a.version);
    },
    async updateSecretVersion(secretId, version, patch) {
      Object.assign(versions.get(`${secretId}@${version}`), patch);
      return versions.get(`${secretId}@${version}`);
    },
    async listSecrets({ projectId, limit, cursor }) {
      return [...secrets.values()]
        .filter((row) => row.project_id === projectId && !row.deleted_at)
        .filter((row) => !cursor || row.created_at > cursor.createdAt
          || (row.created_at === cursor.createdAt && row.id > cursor.id))
        .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
        .slice(0, limit);
    },
    async countSecretReferences() {
      return 0;
    },
  };
  return db;
}

const FORBIDDEN_KEYS = /^(value|token|password|secret|secretaccesskey|sessiontoken|privatekey|privatekeype[mn]|certificatepem|clientsecret|ciphertext|wrappeddek|wrapped_dek|authtag|auth_tag|iv)$/i;

function assertNoSecretFields(node, path = "$") {
  if (Array.isArray(node)) {
    node.forEach((entry, index) => assertNoSecretFields(entry, `${path}[${index}]`));
    return;
  }
  if (typeof node === "object" && node !== null) {
    for (const [key, entry] of Object.entries(node)) {
      assert.ok(!FORBIDDEN_KEYS.test(key), `${path}.${key} looks like a secret value field`);
      assertNoSecretFields(entry, `${path}.${key}`);
    }
  }
}

function normalize(value) {
  return JSON.parse(JSON.stringify(value, (_, entry) => {
    if (typeof entry === "string") {
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(entry)) return "<uuid>";
      if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(entry)) return "<ts>";
    }
    if (entry && typeof entry === "object" && !Array.isArray(entry)
      && ("ciphertext" in entry || "wrappedDek" in entry || "wrapped_dek" in entry)) {
      throw new Error("Snapshot input already contains envelope bytes; the service leaked below the view layer.");
    }
    return entry;
  }));
}

test("S02: management API never returns secret value fields (snapshot of every secrets endpoint response)", async (t) => {
  const db = fakeControlDb();
  const deps = { keys: KEYS };
  const created = await createSecretService(db, ADMIN, {
    projectId: PROJECT, name: "upstream-key", kind: "bearer",
    value: { token: "tok-first-abc123" }, requestId: "req-1",
  }, deps);
  const listed = await listSecrets(db, ADMIN, { projectId: PROJECT });
  const fetched = await getSecret(db, ADMIN, { projectId: PROJECT, secretId: created.body.id });
  const patched = await updateSecret(db, ADMIN, {
    projectId: PROJECT, secretId: created.body.id, patch: { description: "Upstream API key" }, requestId: "req-2",
  });
  const rotated = await rotateSecretService(db, ADMIN, {
    projectId: PROJECT, secretId: created.body.id, value: { token: "tok-second-def456" }, requestId: "req-3",
  }, deps);
  const disabled = await disableSecretVersion(db, ADMIN, {
    projectId: PROJECT, secretId: created.body.id, version: 1, requestId: "req-4",
  });
  const removed = await deleteSecretService(db, ADMIN, {
    projectId: PROJECT, secretId: created.body.id, requestId: "req-5",
  });

  const responses = { created, listed, fetched, patched, rotated, disabled, removed };
  for (const [name, response] of Object.entries(responses)) {
    assertNoSecretFields(response, name);
    const serialized = JSON.stringify(response);
    assert.ok(!serialized.includes("tok-first-abc123"), `${name} leaks the first token`);
    assert.ok(!serialized.includes("tok-second-def456"), `${name} leaks the rotated token`);
  }

  const snapshot = normalize(responses);
  mkdirSync(dirname(SNAPSHOT), { recursive: true });
  if (!existsSync(SNAPSHOT)) {
    writeFileSync(SNAPSHOT, `${JSON.stringify(snapshot, null, 2)}\n`);
    t.skip("Snapshot created for review; re-run to verify.");
    return;
  }
  assert.deepEqual(snapshot, JSON.parse(readFileSync(SNAPSHOT, "utf8")));
});
