import assert from "node:assert/strict";
import test from "node:test";

import rbacConfig from "../../geiger-rbac.config.js";
import { audit, redact } from "../../lib/control/audit.mjs";
import { HttpError } from "../../lib/control/errors.mjs";
import { assertCanGrant } from "../../lib/control/role-grants.mjs";

function bindingFor(roleKey) {
  const role = rbacConfig.systemRoles.find((entry) => entry.key === roleKey);
  const roleId = `project-1:inherited:${roleKey}`;
  return {
    config: rbacConfig,
    roles: [{ ...role, id: roleId }],
    grants: [{ roleId, userId: "grantor-1", projectId: "project-1", scope: {}, status: "active" }],
    actorId: "grantor-1",
  };
}

const API_DEV = { key: "api_developer", permissions: ["pods.route.write", "pods.secret.write"] };

test("S02: grant_role refuses to grant a role containing keys the grantor lacks", () => {
  assert.throws(() => assertCanGrant(bindingFor("manager"), API_DEV), (error) => {
    assert.ok(error instanceof HttpError);
    assert.equal(error.status, 403);
    assert.match(error.message, /pods\.secret\.write/);
    return true;
  });
  assert.deepEqual(assertCanGrant(bindingFor("admin"), API_DEV).sort(), ["pods.route.write", "pods.secret.write"].sort());
  assert.deepEqual(assertCanGrant(bindingFor("owner"), API_DEV).length, 2);
});

test("S02: a scope-restricted holding never authorizes granting", () => {
  const scoped = {
    config: rbacConfig,
    roles: [{ id: "r-scoped", key: "scoped_dev", permissions: ["pods.route.write"] }],
    grants: [{
      roleId: "r-scoped", userId: "grantor-2", projectId: "project-1",
      scope: { api: ["api-1"] }, status: "active",
    }],
    actorId: "grantor-2",
  };
  assert.throws(() => assertCanGrant(scoped, { key: "wide", permissions: ["pods.route.write"] }), (error) => {
    assert.ok(error instanceof HttpError && error.status === 403);
    return true;
  });
});

test("S02: audit redacts secret-like keys in before/after", async () => {
  const stored = [];
  const db = { async insertAudit(entry) { stored.push(entry); } };
  const before = {
    name: "upstream-key",
    token: "tok-abc",
    nested: { secretAccessKey: "shh", region: "us-east-1", list: [{ password: "pw", keep: 1 }] },
    value: { deep: true },
    privateKeyPem: "pem",
    ciphertext: Buffer.from("x"),
  };
  await audit(db, { type: "user", userId: "u-1" }, {
    action: "secret.rotate",
    resourceType: "secret",
    resourceId: "sec-1",
    projectId: "project-1",
    before,
    after: { currentVersion: 2, sessionToken: "tok" },
    requestId: "req-9",
  });
  assert.equal(stored.length, 1);
  const entry = stored[0];
  assert.equal(entry.after.sessionToken, "[redacted]");
  assert.equal(entry.before.token, "[redacted]");
  assert.equal(entry.before.nested.secretAccessKey, "[redacted]");
  assert.equal(entry.before.nested.region, "us-east-1");
  assert.equal(entry.before.nested.list[0].password, "[redacted]");
  assert.equal(entry.before.nested.list[0].keep, 1);
  assert.equal(entry.before.value, "[redacted]");
  assert.equal(entry.before.privateKeyPem, "[redacted]");
  assert.equal(entry.before.ciphertext, "[redacted]");
  assert.equal(entry.before.name, "upstream-key");
  assert.equal(entry.request_id, "req-9");
  // The caller's objects are not mutated.
  assert.equal(before.token, "tok-abc");
  assert.deepEqual(redact(null), null);
  assert.deepEqual(redact("plain"), "plain");
});
