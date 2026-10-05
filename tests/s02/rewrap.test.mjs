import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";

import { loadVaultKeys } from "../../lib/vault/keys.mjs";
import { decryptSecretValue, encryptSecretValue } from "../../lib/vault/crypto.mjs";
import { planRewrap } from "../../scripts/vault-rewrap.mjs";

const KEK_OLD = randomBytes(32);
const KEK_NEW = randomBytes(32);
const KEYS = loadVaultKeys({
  PODS_VAULT_KEYS: JSON.stringify({ old: KEK_OLD.toString("base64"), next: KEK_NEW.toString("base64") }),
  PODS_VAULT_ACTIVE_KID: "next",
});

function rowFor(version, kek, kekId) {
  const envelope = encryptSecretValue({
    projectId: "proj-1", secretId: "sec-1", version,
    plaintext: Buffer.from(`value-${version}`, "utf8"), kek, kekId,
  });
  return {
    id: `row-${version}`, secret_id: "sec-1", version,
    project_id: "proj-1",
    ciphertext: envelope.ciphertext, iv: envelope.iv,
    auth_tag: envelope.authTag, wrapped_dek: envelope.wrappedDek, kek_id: kekId,
  };
}

test("S02: vault rewrap plans only stale rows and keeps values decryptable", () => {
  const rows = [rowFor(1, KEK_OLD, "old"), rowFor(2, KEK_NEW, "next")];
  const plan = planRewrap(rows, { keys: KEYS, toKid: "next" });
  assert.deepEqual(plan.map((entry) => entry.id), ["row-1"]);
  assert.equal(plan[0].kekId, "next");

  const rewrapped = plan[0];
  const plaintext = decryptSecretValue({
    projectId: "proj-1", secretId: "sec-1", version: 1, kek: KEK_NEW,
    ciphertext: rows[0].ciphertext, iv: rows[0].iv,
    authTag: rows[0].auth_tag, wrappedDek: rewrapped.wrappedDek,
  });
  assert.equal(plaintext.toString("utf8"), "value-1");

  assert.throws(() => planRewrap(rows, { keys: KEYS, toKid: "missing" }), /not configured/);
  const unknownKek = [{ ...rows[0], id: "row-x", kek_id: "ghost" }];
  assert.throws(() => planRewrap(unknownKek, { keys: KEYS, toKid: "next" }), /ghost/);
});
