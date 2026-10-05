import assert from "node:assert/strict";
import test from "node:test";
import { planStack, applyStack, driftStack, hashStackFile, STACK_TAG } from "../../lib/control/stacks.mjs";

const PROJECT = "55555555-5555-5555-8555-555555555555";

function stackDb({ failOn = null } = {}) {
  const store = {
    apis: new Map(),
    stacks: new Map(),
    audits: [],
    failOn,
    calls: [],
  };
  return {
    store,
    async getInheritedRole() { return "admin"; },
    async listRoleBindings() { return { roles: [], grants: [] }; },
    async insertAudit(entry) { store.audits.push(entry); },
    async listStackResources() {
      return { api: [...store.apis.values()] };
    },
    async stackCreateApi({ project_id, name, file }) {
      if (store.failOn === `create:${name}`) throw new Error(`injected failure creating ${name}`);
      store.calls.push(`create:${name}`);
      const row = { id: `api-${name}`, project_id, name, description: file.description ?? "", settings: file.settings ?? {} };
      store.apis.set(name, row);
      return row;
    },
    async stackUpdateApi({ name, file }) {
      if (store.failOn === `update:${name}`) throw new Error(`injected failure updating ${name}`);
      store.calls.push(`update:${name}`);
      const row = store.apis.get(name);
      store.apis.set(name, { ...row, description: file.description ?? row.description, settings: file.settings ?? row.settings });
      return store.apis.get(name);
    },
    async stackDeleteApi({ name }) {
      store.calls.push(`delete:${name}`);
      store.apis.delete(name);
    },
    async tagStackResource() {},
    async upsertStack(row) { store.stacks.set(row.name, { ...row, last_applied_at: new Date().toISOString() }); },
    async getStack({ name }) { return store.stacks.get(name) ?? null; },
  };
}

const ADMIN = { type: "user", userId: "u" };
const FILE = {
  version: 1,
  stack: "payments",
  apis: [{ name: "payments-api", protocol: "REST", description: "v1", settings: { endpointType: "REGIONAL" } }],
};

test("S14: plan on unchanged stack → no changes (exit 0); edited field → one update; removed API without --prune → reported, not deleted", async () => {
  const db = stackDb();
  // Empty live state: one create.
  const first = await planStack(db, ADMIN, { projectId: PROJECT, stack: "payments", file: FILE });
  assert.equal(first.changes.length, 1);
  assert.equal(first.changes[0].op, "create");
  assert.equal(typeof first.hash, "string");

  await applyStack(db, ADMIN, { projectId: PROJECT, stack: "payments", file: FILE, changes: first.changes });
  const unchanged = await planStack(db, ADMIN, { projectId: PROJECT, stack: "payments", file: FILE });
  assert.deepEqual(unchanged.changes.filter((op) => op.op !== "noop"), []);

  const edited = {
    ...FILE,
    apis: [{ name: "payments-api", protocol: "REST", description: "v2", settings: { endpointType: "REGIONAL" } }],
  };
  const second = await planStack(db, ADMIN, { projectId: PROJECT, stack: "payments", file: edited });
  const updates = second.changes.filter((op) => op.op === "update");
  assert.equal(updates.length, 1);
  assert.ok(updates[0].diff.description);

  const removed = { version: 1, stack: "payments", apis: [] };
  const third = await planStack(db, ADMIN, { projectId: PROJECT, stack: "payments", file: removed });
  assert.equal(third.changes.length, 1);
  assert.equal(third.changes[0].op, "delete");
  assert.equal(third.changes[0].skipped, "needs_prune");
  // Not deleted without prune.
  await applyStack(db, ADMIN, { projectId: PROJECT, stack: "payments", file: removed, changes: third.changes });
  assert.ok(db.store.apis.has("payments-api"));
  assert.equal(STACK_TAG, "pods:stack");
});

test("S14: apply is re-runnable after an injected mid-run failure and converges", async () => {
  const db = stackDb({ failOn: "create:second" });
  const file = {
    version: 1, stack: "s",
    apis: [{ name: "first", protocol: "REST" }, { name: "second", protocol: "REST" }],
  };
  const planned = await planStack(db, ADMIN, { projectId: PROJECT, stack: "s", file });
  await assert.rejects(applyStack(db, ADMIN, { projectId: PROJECT, stack: "s", file, changes: planned.changes }), /injected failure/);
  assert.ok(db.store.apis.has("first"));
  assert.ok(!db.store.apis.has("second"));
  // Fix the fault and re-run: only the missing resource is created.
  db.store.failOn = null;
  const retry = await planStack(db, ADMIN, { projectId: PROJECT, stack: "s", file });
  const result = await applyStack(db, ADMIN, { projectId: PROJECT, stack: "s", file, changes: retry.changes });
  assert.ok(db.store.apis.has("second"));
  assert.equal(result.failed, null);
  const drift = await driftStack(db, ADMIN, { projectId: PROJECT, stack: "s", file });
  assert.equal(drift.inSync, true);
  assert.equal(drift.fileHash, hashStackFile(file));
  // Secrets values are never accepted in the file.
  await assert.rejects(
    planStack(db, ADMIN, { projectId: PROJECT, stack: "s", file: { version: 1, stack: "s", secrets: [{ name: "k", value: "v" }] } }),
    (error) => error.status === 422,
  );
});
