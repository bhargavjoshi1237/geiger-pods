import assert from "node:assert/strict";
import test from "node:test";
import { getTags, putTags, deleteTags, parseTagFilters } from "../../lib/control/tags.mjs";

const PROJECT = "55555555-5555-5555-8555-555555555555";

function adminDb(store = { tags: [], audits: [] }) {
  return {
    store,
    async getInheritedRole() { return "admin"; },
    async listRoleBindings() { return { roles: [], grants: [] }; },
    async insertAudit(entry) { store.audits.push(entry); },
    async listTags({ projectId, resourceType, resourceId }) {
      return store.tags.filter((row) => row.project_id === projectId && row.resource_type === resourceType && row.resource_id === resourceId);
    },
    async replaceTags({ project_id, resource_type, resource_id, tags }) {
      store.tags = store.tags.filter((row) => !(row.project_id === project_id && row.resource_type === resource_type && row.resource_id === resource_id));
      for (const entry of tags) {
        store.tags.push({ project_id, resource_type, resource_id, key: entry.key, value: entry.value });
      }
    },
  };
}

const ADMIN = { type: "user", userId: "u-admin" };

test("S14: tag rules — 51st tag rejected, reserved prefix rejected, unicode allowed", async () => {
  const db = adminDb();
  const many = {};
  for (let i = 0; i < 51; i++) many[`k${i}`] = "v";
  await assert.rejects(
    putTags(db, ADMIN, { projectId: PROJECT, resourceType: "api", resourceId: "api-1", tags: many }),
    (error) => error.status === 422,
  );
  await assert.rejects(
    putTags(db, ADMIN, { projectId: PROJECT, resourceType: "api", resourceId: "api-1", tags: { "aws:env": "prod" } }),
    (error) => error.status === 422,
  );
  await assert.rejects(
    putTags(db, ADMIN, { projectId: PROJECT, resourceType: "api", resourceId: "api-1", tags: { "pods:stack": "x" } }),
    (error) => error.status === 422,
  );
  await assert.rejects(
    putTags(db, ADMIN, { projectId: PROJECT, resourceType: "lambda", resourceId: "api-1", tags: {} }),
    (error) => error.status === 422,
  );
  const saved = await putTags(db, ADMIN, {
    projectId: PROJECT, resourceType: "api", resourceId: "api-1",
    tags: { "env": "prod", "équipe": "paiements-α", "cost center": "r&d" },
  });
  assert.equal(saved["équipe"], "paiements-α");
  assert.deepEqual(await getTags(db, ADMIN, { projectId: PROJECT, resourceType: "api", resourceId: "api-1" }), saved);
  assert.equal(db.store.audits.length, 1);
  const deleted = await deleteTags(db, ADMIN, { projectId: PROJECT, resourceType: "api", resourceId: "api-1" });
  assert.equal(deleted.deleted, true);
  assert.deepEqual(await getTags(db, ADMIN, { projectId: PROJECT, resourceType: "api", resourceId: "api-1" }), {});
});

test("S14: tag filters parse ?tag:Key=Value query params", () => {
  const filters = parseTagFilters(new URLSearchParams("tag:env=prod&limit=10&tag:team=a%20b"));
  assert.deepEqual(filters, [{ key: "env", value: "prod" }, { key: "team", value: "a b" }]);
});
