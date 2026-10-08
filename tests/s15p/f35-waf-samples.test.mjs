/**
 * F35 (S15): control-plane read API for WAF sampled requests.
 *
 * The gateway records samples in KV (`waf:samples:<aclName>:<stage>:<rule>`,
 * engine-tested); `listSampledRequests` reads them back scoped to one web
 * ACL (404 across projects), with stage/rule filters and a bounded limit.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { listSampledRequests } from "../../lib/control/waf.mjs";
import { recordSampledRequest } from "../../lib/gateway/core/edge/waf-engine.mjs";
import { MemoryKvStore } from "../../lib/gateway/state/memory-kv.mjs";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const actor = { type: "user", userId: "u1" };

function wafDb({ acl, associations = [] } = {}) {
  const row = acl ?? {
    id: "acl-1",
    project_id: PROJECT,
    name: "main",
    default_action: "ALLOW",
    rules: [
      { name: "block-bad", priority: 10, action: "BLOCK", statement: { type: "ByteMatchStatement" } },
      { name: "count-all", priority: 20, action: "COUNT", statement: { type: "ByteMatchStatement" } },
    ],
    custom_responses: {},
    visibility: { sampledRequests: true, metrics: true },
    version: 1,
  };
  return {
    async getInheritedRole() { return "owner"; },
    async listRoleBindings() { return { roles: [], grants: [] }; },
    async insertAudit() {},
    async getWebAclById(id) { return id === row.id ? { ...row } : null; },
    async listAclAssociations() { return associations; },
  };
}

function sampleRequest(method = "GET", path = "/admin") {
  return { method, path, query: "", sourceIp: "203.0.113.7" };
}

async function seed(kv) {
  await recordSampledRequest(kv, { aclId: "main", stage: "prod", ruleName: "block-bad", req: sampleRequest("GET", "/admin"), action: "BLOCK", now: 1000 });
  await recordSampledRequest(kv, { aclId: "main", stage: "prod", ruleName: "block-bad", req: sampleRequest("POST", "/admin"), action: "BLOCK", now: 2000 });
  await recordSampledRequest(kv, { aclId: "main", stage: "prod", ruleName: "count-all", req: sampleRequest("GET", "/"), action: "COUNT", now: 3000 });
  await recordSampledRequest(kv, { aclId: "main", stage: "dev", ruleName: "block-bad", req: sampleRequest("GET", "/x"), action: "BLOCK", now: 4000 });
}

test("F35: sampled requests aggregate across stages and rules, newest first", async () => {
  const kv = new MemoryKvStore({ clock: { now: () => 5000 } });
  await seed(kv);
  const db = wafDb({ associations: [{ id: "a1", api_id: "api-1", stage_name: "prod" }, { id: "a2", api_id: "api-1", stage_name: "dev" }] });
  const out = await listSampledRequests(db, actor, { projectId: PROJECT, aclId: "acl-1", kv, now: 5000 });
  assert.equal(out.aclId, "acl-1");
  assert.equal(out.items.length, 4);
  assert.deepEqual(out.items.map((entry) => entry.t), [4000, 3000, 2000, 1000]);
  assert.ok(out.items.every((entry) => typeof entry.rule === "string" && typeof entry.stage === "string"));
  assert.deepEqual(out.rules, ["block-bad", "count-all"]);
});

test("F35: stage, rule and limit filters narrow the rows", async () => {
  const kv = new MemoryKvStore({ clock: { now: () => 5000 } });
  await seed(kv);
  const db = wafDb({ associations: [{ id: "a1", api_id: "api-1", stage_name: "prod" }, { id: "a2", api_id: "api-1", stage_name: "dev" }] });
  const byStage = await listSampledRequests(db, actor, { projectId: PROJECT, aclId: "acl-1", stage: "dev", kv, now: 5000 });
  assert.equal(byStage.items.length, 1);
  assert.equal(byStage.items[0].path, "/x");
  const byRule = await listSampledRequests(db, actor, { projectId: PROJECT, aclId: "acl-1", rule: "count-all", kv, now: 5000 });
  assert.equal(byRule.items.length, 1);
  assert.equal(byRule.items[0].rule, "count-all");
  const limited = await listSampledRequests(db, actor, { projectId: PROJECT, aclId: "acl-1", limit: 2, kv, now: 5000 });
  assert.equal(limited.items.length, 2);
  assert.deepEqual(limited.items.map((entry) => entry.t), [4000, 3000]);
});

test("F35: unknown ACL, cross-project ACL, bad rule and bad limit are rejected", async () => {
  const kv = new MemoryKvStore({ clock: { now: () => 5000 } });
  const db = wafDb();
  await assert.rejects(
    listSampledRequests(db, actor, { projectId: PROJECT, aclId: "nope", kv }),
    (error) => error.status === 404,
  );
  const other = wafDb({ acl: { id: "acl-9", project_id: "other-project", name: "main", rules: [] } });
  await assert.rejects(
    listSampledRequests(other, actor, { projectId: PROJECT, aclId: "acl-9", kv }),
    (error) => error.status === 404,
  );
  await assert.rejects(
    listSampledRequests(db, actor, { projectId: PROJECT, aclId: "acl-1", rule: "no-such-rule", kv }),
    (error) => error.status === 422,
  );
  await assert.rejects(
    listSampledRequests(db, actor, { projectId: PROJECT, aclId: "acl-1", limit: 500, kv }),
    (error) => error.status === 422,
  );
});

test("F35: no KV (or empty store) returns an empty list, not an error", async () => {
  const db = wafDb();
  const out = await listSampledRequests(db, actor, { projectId: PROJECT, aclId: "acl-1", kv: null });
  assert.deepEqual(out.items, []);
  assert.equal(out.kvAvailable, false);
  const empty = await listSampledRequests(db, actor, {
    projectId: PROJECT, aclId: "acl-1", kv: new MemoryKvStore({ clock: { now: () => 1 } }),
  });
  assert.deepEqual(empty.items, []);
  assert.equal(empty.kvAvailable, true);
});
