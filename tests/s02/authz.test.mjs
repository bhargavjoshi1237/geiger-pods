import assert from "node:assert/strict";
import test from "node:test";

import config from "../../geiger-rbac.config.js";
import { requirePermission } from "../../lib/control/authz.mjs";
import { HttpError } from "../../lib/control/errors.mjs";

function fakeDb(roleByUser) {
  return {
    async getInheritedRole({ userId }) {
      return roleByUser[userId] ?? null;
    },
    async listRoleBindings() {
      return { roles: [], grants: [] };
    },
  };
}

const PROJECT = "11111111-1111-4111-8111-111111111111";
const db = fakeDb({ "u-member": "member", "u-manager": "manager", "u-admin": "admin", "u-owner": "owner" });
const actor = (userId) => ({ type: "user", userId });

async function denies(promise, status, code) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof HttpError, `expected HttpError, got ${error}`);
    assert.equal(error.status, status);
    assert.equal(error.code, code);
    return true;
  });
}

test("S02: member cannot create a secret; manager can use but not write; admin can write", async () => {
  await denies(
    requirePermission(db, actor("u-member"), "pods.secret.write", { projectId: PROJECT }),
    403,
    "forbidden",
  );
  const useDecision = await requirePermission(db, actor("u-manager"), "pods.secret.use", { projectId: PROJECT });
  assert.equal(useDecision.allowed, true);
  await denies(
    requirePermission(db, actor("u-manager"), "pods.secret.write", { projectId: PROJECT }),
    403,
    "forbidden",
  );
  const writeDecision = await requirePermission(db, actor("u-admin"), "pods.secret.write", { projectId: PROJECT });
  assert.equal(writeDecision.allowed, true);
});

test("S02: role grants and unauthenticated callers fail closed", async () => {
  const ownerGrant = await requirePermission(db, actor("u-owner"), "pods.role.grant", { projectId: PROJECT });
  assert.equal(ownerGrant.allowed, true);
  await denies(requirePermission(db, actor("u-admin"), "pods.role.grant", { projectId: PROJECT }), 403, "forbidden");
  await denies(requirePermission(db, null, "pods.settings.view", { projectId: PROJECT }), 401, "unauthenticated");
  await denies(
    requirePermission(db, actor("u-manager"), "pods.api.create", { projectId: PROJECT }),
    403,
    "forbidden",
  );
  // Unknown permission keys fail closed even for the owner.
  await denies(requirePermission(db, actor("u-owner"), "pods.nope.missing", { projectId: PROJECT }), 403, "forbidden");
  assert.ok(config.systemRoles.some((role) => role.key === "owner"));
});
