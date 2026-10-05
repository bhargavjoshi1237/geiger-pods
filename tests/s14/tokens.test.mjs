import assert from "node:assert/strict";
import test from "node:test";
import {
  createToken, listTokens, revokeToken, resolveToken, matchesScope, hashToken,
} from "../../lib/control/access-tokens.mjs";
import { requirePermission } from "../../lib/control/authz.mjs";

const PROJECT = "55555555-5555-5555-8555-555555555555";
const OTHER_PROJECT = "66666666-6666-6666-8666-666666666666";

function rig({ role = "admin", grants = [] } = {}) {
  const store = { tokens: new Map(), audits: [], uses: [] };
  const db = {
    store,
    async getInheritedRole() { return role; },
    async listRoleBindings() {
      return {
        roles: grants.length > 0
          ? [{ id: "r", key: "custom", name: "Custom", permissions: grants }]
          : [],
        grants: grants.length > 0
          ? [{ id: "g", roleId: "r", userId: "u", projectId: PROJECT, scope: {}, status: "active" }]
          : [],
      };
    },
    async insertAudit(entry) { store.audits.push(entry); },
    async listTokens({ projectId }) {
      return [...store.tokens.values()].filter((row) => row.project_id === projectId);
    },
    async insertToken(row) {
      const saved = { id: `tok-${store.tokens.size + 1}`, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), version: 1, revoked_at: null, ...row };
      store.tokens.set(saved.id, saved);
      return saved;
    },
    async getTokenById({ id }) { return store.tokens.get(id) ?? null; },
    async getTokenByHash({ hash }) {
      return [...store.tokens.values()].find((row) => row.token_hash === hash) ?? null;
    },
    async revokeToken({ id }) { store.tokens.get(id).revoked_at = new Date().toISOString(); },
    async recordTokenUse({ id, ip }) { store.uses.push({ id, ip }); },
  };
  return db;
}

const ADMIN = { type: "user", userId: "u" };

test("S14: service token cannot be granted scopes the creator lacks", async () => {
  const db = rig({ role: null, grants: ["pods.apis.view", "pods.token.write"] });
  const member = { type: "user", userId: "u" };
  await assert.rejects(
    createToken(db, member, { projectId: PROJECT, kind: "service", name: "ci", scopes: ["pods.api.delete"] }),
    (error) => error.status === 403,
  );
  const created = await createToken(db, member, { projectId: PROJECT, kind: "service", name: "ci", scopes: ["pods.apis.view"] });
  assert.match(created.token, /^pods_svc_[A-Za-z0-9]{43}$/);
  assert.ok(!("token_hash" in created));
  const listed = await listTokens(db, ADMIN, { projectId: PROJECT });
  assert.equal(listed.length, 1);
  assert.ok(!("token" in listed[0]));
  assert.ok(listed[0].prefix.startsWith("pods_svc_"));
});

test("S14: personal token requires expiry ≤ 1 year; shown once; revocation is immediate", async () => {
  const db = rig();
  await assert.rejects(
    createToken(db, ADMIN, { projectId: PROJECT, kind: "personal", name: "cli", scopes: ["pods.apis.view"] }),
    (error) => error.status === 422,
  );
  await assert.rejects(
    createToken(db, ADMIN, {
      projectId: PROJECT, kind: "personal", name: "cli", scopes: ["pods.apis.view"],
      expiresAt: new Date(Date.now() + 400 * 24 * 3600 * 1000).toISOString(),
    }),
    (error) => error.status === 422,
  );
  const created = await createToken(db, ADMIN, {
    projectId: PROJECT, kind: "personal", name: "cli", scopes: ["pods.apis.view"],
    expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
  });
  assert.match(created.token, /^pods_pat_/);
  const actor = await resolveToken(db, created.token, { ip: "9.9.9.9" });
  assert.equal(actor?.type, "token");
  assert.equal(actor?.userId, ADMIN.userId);
  assert.equal(db.store.uses.length, 1);
  await revokeToken(db, ADMIN, { projectId: PROJECT, tokenId: created.id });
  assert.equal(await resolveToken(db, created.token), null);
});

test("S14: personal token permissions = scopes ∩ current user permissions; removing the user makes the token useless immediately", async () => {
  const db = rig({ role: "admin" });
  // Admin creates a personal token carrying api.delete.
  const created = await createToken(db, ADMIN, {
    projectId: PROJECT, kind: "personal", name: "ops", scopes: ["pods.api.delete"],
    expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
  });
  const actor = await resolveToken(db, created.token);
  // While the user is admin, the token passes.
  await requirePermission(db, actor, "pods.api.delete", { projectId: PROJECT });
  // The user is removed (role gone, no grants): the same token now fails.
  db.getInheritedRole = async () => null;
  db.listRoleBindings = async () => ({ roles: [], grants: [] });
  await assert.rejects(
    requirePermission(db, actor, "pods.api.delete", { projectId: PROJECT }),
    (error) => error.status === 403,
  );
  // A service token bound to another project cannot cross over.
  const svc = await createToken(rig(), ADMIN, { projectId: OTHER_PROJECT, kind: "service", name: "x", scopes: ["*"] }).catch(() => null);
  void svc;
  const foreign = { type: "token", tokenId: "t", projectId: OTHER_PROJECT, userId: null, kind: "service", scopes: ["*"], name: "x" };
  await assert.rejects(
    requirePermission(db, foreign, "pods.apis.view", { projectId: PROJECT }),
    (error) => error.status === 403,
  );
  // Service token with scope passes without a user.
  const svcActor = { type: "token", tokenId: "t", projectId: PROJECT, userId: null, kind: "service", scopes: ["pods.apis.view"], name: "ci" };
  await requirePermission(db, svcActor, "pods.apis.view", { projectId: PROJECT });
  await assert.rejects(
    requirePermission(db, svcActor, "pods.api.delete", { projectId: PROJECT }),
    (error) => error.status === 403,
  );
});

test("S14: scope matcher supports exact, prefix and star patterns", () => {
  assert.equal(matchesScope("*", "pods.anything.here"), true);
  assert.equal(matchesScope("pods.api.*", "pods.api.delete"), true);
  assert.equal(matchesScope("pods.api.*", "pods.apis.view"), false);
  assert.equal(matchesScope("pods.apis.view", "pods.apis.view"), true);
  assert.equal(hashToken("x").length, 64);
});
