import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes, randomUUID } from "node:crypto";

import { loadVaultKeys } from "../../lib/vault/keys.mjs";
import {
  aadFor,
  decryptSecretValue,
  encryptSecretValue,
  rewrapDek,
} from "../../lib/vault/crypto.mjs";
import { VaultError, createSecret, disableVersion, resolveSecretRef, rotateSecret } from "../../lib/vault/secrets.mjs";

const KEK_A = randomBytes(32);
const KEK_B = randomBytes(32);
const KEYS = loadVaultKeys({
  PODS_VAULT_KEYS: JSON.stringify({ k1: KEK_A.toString("base64"), k2: KEK_B.toString("base64") }),
  PODS_VAULT_ACTIVE_KID: "k1",
});
const KEK = { keys: { k1: KEK_A, k2: KEK_B }, activeKid: "k1" };

const AAD = { projectId: "proj-1", secretId: "sec-1", version: 1 };

function encrypted(value = "s3cr3t-value") {
  return encryptSecretValue({
    ...AAD,
    plaintext: Buffer.from(value, "utf8"),
    kek: KEK_A,
    kekId: "k1",
  });
}

test("S02: vault round-trips a value; tampered ciphertext, wrong AAD and wrong KEK each fail", () => {
  const row = encrypted();
  assert.equal(decryptSecretValue({ ...AAD, kek: KEK_A, ...row }).toString("utf8"), "s3cr3t-value");
  assert.equal(aadFor("proj-1", "sec-1", 1), "proj-1:sec-1:1");

  const tampered = { ...row, ciphertext: Buffer.from(row.ciphertext) };
  tampered.ciphertext[0] ^= 0xff;
  assert.throws(() => decryptSecretValue({ ...AAD, kek: KEK_A, ...tampered }), VaultError);

  const tamperedTag = { ...row, authTag: Buffer.from(row.authTag) };
  tamperedTag.authTag[0] ^= 0xff;
  assert.throws(() => decryptSecretValue({ ...AAD, kek: KEK_A, ...tamperedTag }), VaultError);

  const tamperedDek = { ...row, wrappedDek: Buffer.from(row.wrappedDek) };
  tamperedDek.wrappedDek[tamperedDek.wrappedDek.length - 1] ^= 0xff;
  assert.throws(() => decryptSecretValue({ ...AAD, kek: KEK_A, ...tamperedDek }), VaultError);

  assert.throws(() => decryptSecretValue({ ...AAD, projectId: "proj-2", kek: KEK_A, ...row }), VaultError);
  assert.throws(() => decryptSecretValue({ ...AAD, version: 2, kek: KEK_A, ...row }), VaultError);
  assert.throws(() => decryptSecretValue({ ...AAD, kek: KEK_B, ...row }), VaultError);

  const rewrapped = rewrapDek({ ...AAD, wrappedDek: row.wrappedDek, fromKek: KEK_A, toKek: KEK_B, toKid: "k2" });
  assert.equal(rewrapped.kekId, "k2");
  assert.equal(
    decryptSecretValue({ ...AAD, kek: KEK_B, ...row, wrappedDek: rewrapped.wrappedDek }).toString("utf8"),
    "s3cr3t-value",
  );
  assert.throws(
    () => rewrapDek({ ...AAD, wrappedDek: row.wrappedDek, fromKek: KEK_B, toKek: KEK_A, toKid: "k1" }),
    VaultError,
  );
});

function fakeSecretDb() {
  const secrets = new Map();
  const versions = new Map();
  return {
    async insertSecret(row) {
      const secret = {
        id: randomUUID(), created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        last_rotated_at: new Date().toISOString(), deleted_at: null, expires_at: null, description: null,
        ...row,
      };
      secrets.set(secret.id, secret);
      return secret;
    },
    async getSecretById(id) {
      return secrets.get(id) ?? null;
    },
    async updateSecret(id, patch) {
      const secret = secrets.get(id);
      if (!secret) return null;
      Object.assign(secret, patch, { updated_at: new Date().toISOString() });
      return secret;
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
      return [...versions.values()].filter((row) => row.secret_id === secretId).sort((a, b) => b.version - a.version);
    },
    async updateSecretVersion(secretId, version, patch) {
      const record = versions.get(`${secretId}@${version}`);
      if (!record) return null;
      Object.assign(record, patch);
      return record;
    },
    async countSecretReferences() {
      return 0;
    },
  };
}

const ACTOR = { type: "user", userId: "u-1" };

test("S02: rotate keeps old version resolvable until disabled; disabled version resolve throws", async () => {
  const db = fakeSecretDb();
  const created = await createSecret(db, ACTOR, {
    projectId: "proj-1",
    name: "upstream-key",
    kind: "bearer",
    value: { token: "first-token" },
  }, { keys: KEYS });
  assert.equal(created.currentVersion, 1);
  assert.ok(!JSON.stringify(created).includes("first-token"), "public view must not leak the value");

  const rotated = await rotateSecret(db, ACTOR, { secretId: created.id, value: { token: "second-token" } }, { keys: KEYS });
  assert.equal(rotated.currentVersion, 2);

  const latest = await resolveSecretRef(db, `secret:${created.id}`, { projectId: "proj-1", keys: KEYS });
  assert.deepEqual(latest.value, { token: "second-token" });

  const old = await resolveSecretRef(db, `secret:${created.id}@1`, { projectId: "proj-1", keys: KEYS });
  assert.deepEqual(old.value, { token: "first-token" });

  await disableVersion(db, ACTOR, { secretId: created.id, version: 1 });
  await assert.rejects(
    resolveSecretRef(db, `secret:${created.id}@1`, { projectId: "proj-1", keys: KEYS }),
    VaultError,
  );
  const stillLatest = await resolveSecretRef(db, `secret:${created.id}`, { projectId: "proj-1", keys: KEYS });
  assert.deepEqual(stillLatest.value, { token: "second-token" });
});

test("S02: vault rejects bad kinds, bad values and unknown refs", async () => {
  const db = fakeSecretDb();
  await assert.rejects(createSecret(db, ACTOR, {
    projectId: "proj-1", name: "bad", kind: "nope", value: {},
  }, { keys: KEYS }), VaultError);
  await assert.rejects(createSecret(db, ACTOR, {
    projectId: "proj-1", name: "bad", kind: "bearer", value: {},
  }, { keys: KEYS }), VaultError);
  await assert.rejects(resolveSecretRef(db, "not-a-ref", { projectId: "proj-1", keys: KEYS }), VaultError);
  await assert.rejects(
    resolveSecretRef(db, `secret:${randomUUID()}`, { projectId: "proj-1", keys: KEYS }),
    VaultError,
  );
});

test("S02: vault startup fails when the active key is missing", () => {
  assert.throws(() => loadVaultKeys({}), /PODS_VAULT_KEYS/);
  assert.throws(() => loadVaultKeys({
    PODS_VAULT_KEYS: JSON.stringify({ k1: KEK_A.toString("base64") }),
  }), /PODS_VAULT_ACTIVE_KID/);
  assert.throws(() => loadVaultKeys({
    PODS_VAULT_KEYS: JSON.stringify({ k1: KEK_A.toString("base64") }),
    PODS_VAULT_ACTIVE_KID: "k9",
  }), /PODS_VAULT_ACTIVE_KID/);
  assert.throws(() => loadVaultKeys({
    PODS_VAULT_KEYS: JSON.stringify({ k1: "short" }),
    PODS_VAULT_ACTIVE_KID: "k1",
  }), /32 bytes/);
});
