/**
 * S08 control-plane acceptance tests: API keys, usage plans, throttling
 * validation, quotas and usage reporting. Services run against the S08
 * fake db + real vault (test KEK) + memory KV. No network.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { MemoryKvStore } from "../../lib/gateway/state/memory-kv.mjs";
import { hmacForValue } from "../../lib/gateway/core/usage/api-key.mjs";
import { periodStartFor } from "../../lib/gateway/core/usage/quota.mjs";
import { HttpError } from "../../lib/control/errors.mjs";
import { createFakeDb, makeTestKeys } from "./fake-db.mjs";
import {
  createApiKey,
  deleteApiKey,
  getApiKey,
  importApiKeys,
  revealApiKey,
  rotateApiKey,
  updateApiKey,
} from "../../lib/control/api-keys.mjs";
import {
  addKeyToPlan,
  addPlanStage,
  createPlan,
  deletePlan,
  getPlan,
  getUsage,
  removeKeyFromPlan,
  removePlanStage,
  setPlanMethodThrottles,
  updatePlan,
  updateStageThrottle,
  updateUsage,
} from "../../lib/control/usage-plans.mjs";

process.env.PODS_KEY_PEPPER = "test-pepper-s08";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const ADMIN = { type: "user", userId: "u-admin" };
const MANAGER = { type: "user", userId: "u-manager" };
const MEMBER = { type: "user", userId: "u-member" };
const KEYS = makeTestKeys();

function dbWithRoles() {
  return createFakeDb({ roles: { "u-admin": "admin", "u-manager": "manager", "u-member": "member" } });
}

function deps(kv = null) {
  return { keys: KEYS, kv: kv ?? new MemoryKvStore({ clock: { now: () => Date.UTC(2026, 9, 4, 12, 0, 0) } }) };
}

async function seedRestApi(db, { protocol = "REST", publicId = "a1b2c3d4e5" } = {}) {
  return db.insertApi({ project_id: PROJECT, public_id: publicId, name: `api-${publicId}`, protocol });
}

async function seedKey(db, dep, { value, name = "mobile-app" } = {}) {
  const created = await createApiKey(db, ADMIN, {
    projectId: PROJECT, name, ...(value ? { value } : {}),
  }, dep);
  return created.body;
}

async function seedPlan(db, { name = "bronze", throttle = null, quota = null } = {}) {
  const created = await createPlan(db, ADMIN, {
    projectId: PROJECT, name, ...(throttle ? { throttle } : {}), ...(quota ? { quota } : {}),
  });
  return created.body;
}

async function assertHttp(promise, status, code) {
  await assert.rejects(
    promise,
    (error) => {
      assert.ok(error instanceof HttpError, `expected HttpError, got ${error}`);
      assert.equal(error.status, status);
      if (code !== undefined) assert.equal(error.code, code);
      return true;
    },
  );
}

test("S08: value shown once on create; reveal needs pods.api_key.reveal and writes audit", async () => {
  const db = dbWithRoles();
  const dep = deps();
  const created = await createApiKey(db, ADMIN, { projectId: PROJECT, name: "mobile-app" }, dep);
  assert.equal(created.status, 201);
  assert.equal(created.body.value.length, 40);
  assert.equal(created.body.prefix, created.body.value.slice(0, 6));
  assert.ok(!("value_hmac" in created.body) && !("value_ref" in created.body));

  const listed = await getApiKey(db, ADMIN, { projectId: PROJECT, keyId: created.body.id });
  assert.ok(!("value" in listed), "metadata never carries the value");

  // Manager (no reveal key) is denied; member cannot even read.
  await assertHttp(revealApiKey(db, MANAGER, { projectId: PROJECT, keyId: created.body.id }, dep), 403, "forbidden");
  await assertHttp(getApiKey(db, MEMBER, { projectId: PROJECT, keyId: created.body.id }), 403, "forbidden");

  const revealed = await revealApiKey(db, ADMIN, { projectId: PROJECT, keyId: created.body.id }, dep);
  assert.equal(revealed.value, created.body.value);
  const revealAudits = db.audits.filter((entry) => entry.action === "api_key.reveal");
  assert.equal(revealAudits.length, 1);
  assert.ok(!JSON.stringify(revealAudits[0]).includes(created.body.value), "audit never stores the value");
});

test("S08: custom values validate (20-128 charset); duplicates 409; disable flips runtime", async () => {
  const db = dbWithRoles();
  const dep = deps();
  await assertHttp(
    createApiKey(db, ADMIN, { projectId: PROJECT, name: "bad", value: "short" }, dep), 422, "invalid_input",
  );
  const first = await seedKey(db, dep, { value: "Z".repeat(40) });
  await assertHttp(
    createApiKey(db, ADMIN, { projectId: PROJECT, name: "dup", value: "Z".repeat(40) }, dep), 409, "conflict",
  );
  const disabled = await updateApiKey(db, ADMIN, {
    projectId: PROJECT, keyId: first.id, patch: { enabled: false }, expectedVersion: first.version,
  }, dep);
  assert.equal(disabled.enabled, false);
  await assertHttp(
    updateApiKey(db, ADMIN, { projectId: PROJECT, keyId: first.id, patch: { enabled: true }, expectedVersion: first.version }),
    409, "version_conflict",
  );
  const gone = await deleteApiKey(db, ADMIN, { projectId: PROJECT, keyId: first.id }, dep);
  assert.equal(gone.deleted, true);
  await assertHttp(getApiKey(db, ADMIN, { projectId: PROJECT, keyId: first.id }), 404, "not_found");
});

test("S08: key cannot join two plans covering the same API stage (409)", async () => {
  const db = dbWithRoles();
  const dep = deps();
  const api = await seedRestApi(db);
  const key = await seedKey(db, dep);
  const bronze = await seedPlan(db, { name: "bronze" });
  const silver = await seedPlan(db, { name: "silver" });
  await addPlanStage(db, ADMIN, { projectId: PROJECT, planId: bronze.id, apiId: api.id, stage: "prod" }, dep);
  await addPlanStage(db, ADMIN, { projectId: PROJECT, planId: silver.id, apiId: api.id, stage: "prod" }, dep);
  await addKeyToPlan(db, ADMIN, { projectId: PROJECT, planId: bronze.id, keyId: key.id }, dep);
  await assertHttp(
    addKeyToPlan(db, ADMIN, { projectId: PROJECT, planId: silver.id, keyId: key.id }, dep), 409, "conflict",
  );
  // Different stage is fine: a third plan covering only dev.
  const gold = await seedPlan(db, { name: "gold" });
  await addPlanStage(db, ADMIN, { projectId: PROJECT, planId: gold.id, apiId: api.id, stage: "dev" }, dep);
  await deleteApiKey(db, ADMIN, { projectId: PROJECT, keyId: key.id }, dep);
  const key2 = await seedKey(db, dep, { name: "second" });
  // A key may belong to plans covering disjoint stages (bronze/prod + gold/dev).
  await addKeyToPlan(db, ADMIN, { projectId: PROJECT, planId: bronze.id, keyId: key2.id }, dep);
  await addKeyToPlan(db, ADMIN, { projectId: PROJECT, planId: gold.id, keyId: key2.id }, dep);
  // ... but not twice to the same plan.
  await assertHttp(
    addKeyToPlan(db, ADMIN, { projectId: PROJECT, planId: bronze.id, keyId: key2.id }, dep), 409, "conflict",
  );
  await removeKeyFromPlan(db, ADMIN, { projectId: PROJECT, planId: bronze.id, keyId: key2.id }, dep);
});

test("S08: import CSV (AWS format) creates keys and plan associations; bad row → warning, failOnWarnings → 400 and nothing created", async () => {
  const db = dbWithRoles();
  const dep = deps();
  const api = await seedRestApi(db);
  const plan = await seedPlan(db, { name: "imported-plan" });
  await addPlanStage(db, ADMIN, { projectId: PROJECT, planId: plan.id, apiId: api.id, stage: "prod" }, dep);

  const csv = [
    "Name,Key,Description,Enabled,UsagePlanIds",
    `alpha,${"A".repeat(40)},first key,true,${plan.publicId}`,
    "beta,,second key,false,",
    `gamma,short,third key,true,${plan.publicId}`,
    `delta,${"D".repeat(40)},fourth key,true,no-such-plan`,
  ].join("\n");
  const imported = await importApiKeys(db, ADMIN, { projectId: PROJECT, csv }, dep);
  assert.deepEqual(imported.body.ids.length, 3);
  assert.equal(imported.body.warnings.length, 2);
  assert.ok(imported.body.warnings.some((warning) => warning.includes("gamma")));
  assert.ok(imported.body.warnings.some((warning) => warning.includes("no-such-plan")));

  const keys = await db.listApiKeys({ projectId: PROJECT });
  assert.equal(keys.length, 3);
  const alpha = keys.find((row) => row.name === "alpha");
  assert.equal(alpha.description, "first key");
  const alphaPlans = await db.listPlansForKey({ keyId: alpha.id });
  assert.equal(alphaPlans.length, 1);
  const beta = keys.find((row) => row.name === "beta");
  assert.equal(beta.enabled, false);
  assert.match(beta.value_hmac, /^[0-9a-f]{64}$/);

  // failOnWarnings is atomic: nothing is created.
  const before = (await db.listApiKeys({ projectId: PROJECT })).length;
  await assertHttp(
    importApiKeys(db, ADMIN, { projectId: PROJECT, csv, failOnWarnings: true }, dep), 400, "import_warnings",
  );
  assert.equal((await db.listApiKeys({ projectId: PROJECT })).length, before);
});

test("S08: rotate copies name (suffixed), plans and tags; old key stays enabled", async () => {
  const db = dbWithRoles();
  const dep = deps();
  const api = await seedRestApi(db);
  const key = await seedKey(db, dep, { name: "tagged" });
  await updateApiKey(db, ADMIN, {
    projectId: PROJECT, keyId: key.id, patch: { tags: { team: "mobile" }, customerId: "cust-7" }, expectedVersion: key.version,
  }, dep);
  const plan = await seedPlan(db);
  await addPlanStage(db, ADMIN, { projectId: PROJECT, planId: plan.id, apiId: api.id, stage: "prod" }, dep);
  await addKeyToPlan(db, ADMIN, { projectId: PROJECT, planId: plan.id, keyId: key.id }, dep);

  const rotated = await rotateApiKey(db, ADMIN, { projectId: PROJECT, keyId: key.id }, dep);
  assert.equal(rotated.status, 201);
  assert.equal(rotated.body.name, "tagged (rotated)");
  assert.equal(rotated.body.value.length, 40);
  assert.notEqual(rotated.body.value, key.value);
  assert.deepEqual(rotated.body.tags, { team: "mobile" });
  const plans = await db.listPlansForKey({ keyId: rotated.body.id });
  assert.deepEqual(plans.map((row) => row.plan_id), [plan.id]);
  const old = await getApiKey(db, ADMIN, { projectId: PROJECT, keyId: key.id });
  assert.equal(old.enabled, true);
});

test("S08: plan throttle above project level → 422; method throttles capped at 20", async () => {
  const db = dbWithRoles();
  const dep = deps();
  await assertHttp(
    createPlan(db, ADMIN, { projectId: PROJECT, name: "huge", throttle: { rateLimit: 20000, burstLimit: 100 } }),
    422, "invalid_input",
  );
  const plan = await seedPlan(db, { name: "ok", throttle: { rateLimit: 100, burstLimit: 50 } });
  const methods = {};
  for (let index = 0; index < 21; index += 1) methods[`/r${index}/GET`] = { rateLimit: 1, burstLimit: 1 };
  await assertHttp(
    updatePlan(db, ADMIN, { projectId: PROJECT, planId: plan.id, patch: { methodThrottles: methods } }),
    422, "invalid_input",
  );
  await assertHttp(
    createPlan(db, ADMIN, { projectId: PROJECT, name: "badq", quota: { limit: -1, period: "DAY" } }),
    422, "invalid_input",
  );
  const renamed = await updatePlan(db, ADMIN, {
    projectId: PROJECT, planId: plan.id, patch: { description: "d" }, expectedVersion: plan.version,
  });
  assert.equal(renamed.description, "d");
  const fetched = await getPlan(db, ADMIN, { projectId: PROJECT, planId: plan.id });
  assert.equal(fetched.publicId, plan.publicId);
  const dropped = await deletePlan(db, ADMIN, { projectId: PROJECT, planId: plan.id });
  assert.equal(dropped.deleted, true);
});

test("S08: HTTP API rejects usage plan association (capability) with 400 capability_unsupported", async () => {
  const db = dbWithRoles();
  const dep = deps();
  const http = await seedRestApi(db, { protocol: "HTTP", publicId: "h1h2h3h4h5" });
  const plan = await seedPlan(db);
  await assertHttp(
    addPlanStage(db, ADMIN, { projectId: PROJECT, planId: plan.id, apiId: http.id, stage: "$default" }, dep),
    400, "capability_unsupported",
  );
  const ws = await seedRestApi(db, { protocol: "WEBSOCKET", publicId: "w1w2w3w4w5" });
  await addPlanStage(db, ADMIN, { projectId: PROJECT, planId: plan.id, apiId: ws.id, stage: "prod" }, dep);
  await removePlanStage(db, ADMIN, { projectId: PROJECT, planId: plan.id, apiId: ws.id, stage: "prod" }, dep);
});

test("S08: plan method throttles persist; stage throttle validates against project (422)", async () => {
  const db = dbWithRoles();
  const dep = deps();
  const api = await seedRestApi(db);
  const plan = await seedPlan(db);
  await addPlanStage(db, ADMIN, { projectId: PROJECT, planId: plan.id, apiId: api.id, stage: "prod" }, dep);
  const updated = await setPlanMethodThrottles(db, ADMIN, {
    projectId: PROJECT, planId: plan.id, apiId: api.id, stage: "prod",
    methodThrottles: { "/pets/GET": { rateLimit: 10, burstLimit: 5 } },
  }, dep);
  assert.deepEqual(updated.methodThrottles, { "/pets/GET": { rateLimit: 10, burstLimit: 5 } });

  await db.insertStage({ project_id: PROJECT, api_id: api.id, name: "prod" });
  await assertHttp(
    updateStageThrottle(db, ADMIN, {
      projectId: PROJECT, apiId: api.id, stageName: "prod",
      defaultThrottle: { rateLimit: 99999, burstLimit: 10 },
    }),
    422, "invalid_input",
  );
  const throttled = await updateStageThrottle(db, ADMIN, {
    projectId: PROJECT, apiId: api.id, stageName: "prod",
    defaultThrottle: { rateLimit: 500, burstLimit: 250 },
    methodThrottles: { "/pets/GET": { rateLimit: 100, burstLimit: 50 } },
  });
  assert.deepEqual(throttled.defaultThrottle, { rateLimit: 500, burstLimit: 250 });
});

test("S08: extend/reset/set usage writes adjustments and changes the live allowance", async () => {
  const db = dbWithRoles();
  const clockMs = Date.UTC(2026, 9, 4, 12, 0, 0);
  const kv = new MemoryKvStore({ clock: { now: () => clockMs } });
  const dep = { keys: KEYS, kv, now: () => clockMs };
  const api = await seedRestApi(db);
  const key = await seedKey(db, dep);
  const plan = await seedPlan(db, { quota: { limit: 5, period: "DAY" } });
  await addPlanStage(db, ADMIN, { projectId: PROJECT, planId: plan.id, apiId: api.id, stage: "prod" }, dep);
  await addKeyToPlan(db, ADMIN, { projectId: PROJECT, planId: plan.id, keyId: key.id }, dep);

  // Key outside the plan cannot be adjusted.
  const outsider = await seedKey(db, dep, { name: "outsider" });
  await assertHttp(
    updateUsage(db, ADMIN, { projectId: PROJECT, planId: plan.id, keyId: outsider.id, op: "extend", value: 1 }, dep),
    404, "not_found",
  );
  await assertHttp(
    updateUsage(db, ADMIN, { projectId: PROJECT, planId: plan.id, keyId: key.id, op: "bogus", value: 1 }, dep),
    422, "invalid_input",
  );

  const extended = await updateUsage(db, ADMIN, {
    projectId: PROJECT, planId: plan.id, keyId: key.id, op: "extend", value: 10,
  }, dep);
  assert.equal(extended.allowance, 15);
  assert.equal(extended.remaining, 15);
  const rows = await db.listQuotaAdjustments({ planId: plan.id, keyId: key.id });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].delta, 10);

  const reset = await updateUsage(db, ADMIN, {
    projectId: PROJECT, planId: plan.id, keyId: key.id, op: "reset",
  }, dep);
  assert.equal(reset.allowance, 5);
});

test("S08: GetUsage returns AWS-shaped items with used/remaining per day", async () => {
  const db = dbWithRoles();
  const todayMs = Date.UTC(2026, 9, 4, 12, 0, 0);
  const kv = new MemoryKvStore({ clock: { now: () => todayMs } });
  const dep = { keys: KEYS, kv, now: () => todayMs };
  const api = await seedRestApi(db);
  const key = await seedKey(db, dep);
  const plan = await seedPlan(db, { quota: { limit: 5, period: "DAY" } });
  await addPlanStage(db, ADMIN, { projectId: PROJECT, planId: plan.id, apiId: api.id, stage: "prod" }, dep);
  await addKeyToPlan(db, ADMIN, { projectId: PROJECT, planId: plan.id, keyId: key.id }, dep);

  await db.insertUsageDaily({
    project_id: PROJECT, plan_id: plan.id, api_key_id: key.id, api_id: api.id,
    stage_name: "prod", day: "2026-10-03", count: 3, throttled: 0, quota_rejected: 0,
  });
  const periodStart = periodStartFor("DAY", todayMs);
  await kv.incrBy(`q:${plan.id}:${key.id}:${periodStart}`, 2);

  const usage = await getUsage(db, MANAGER, {
    projectId: PROJECT, planId: plan.id, startDate: "2026-10-03", endDate: "2026-10-04",
  }, dep);
  assert.equal(usage.usagePlanId, plan.id);
  assert.equal(usage.startDate, "2026-10-03");
  assert.equal(usage.endDate, "2026-10-04");
  assert.deepEqual(usage.items[key.publicId], [[3, 2], [2, 3]]);
  assert.equal(usage.position, null);

  // Member holds pods.usage.view (read-only usage access is by design);
  // a non-member is denied.
  const memberView = await getUsage(db, MEMBER, {
    projectId: PROJECT, planId: plan.id, startDate: "2026-10-03", endDate: "2026-10-04",
  }, dep);
  assert.deepEqual(memberView.items[key.publicId], [[3, 2], [2, 3]]);
  await assertHttp(
    getUsage(db, { type: "user", userId: "u-stranger" }, { projectId: PROJECT, planId: plan.id, startDate: "2026-10-03", endDate: "2026-10-04" }, dep),
    403, "forbidden",
  );
  await assertHttp(
    getUsage(db, MANAGER, { projectId: PROJECT, planId: plan.id, startDate: "2026-10-05", endDate: "2026-10-04" }, dep),
    422, "invalid_input",
  );
});

test("S08: key cache refreshes on mutation (hmac lookup finds plans without redeploy)", async () => {
  const db = dbWithRoles();
  const kv = new MemoryKvStore({ clock: { now: () => Date.UTC(2026, 9, 4, 12, 0, 0) } });
  const dep = { keys: KEYS, kv };
  const api = await seedRestApi(db);
  const created = await createApiKey(db, ADMIN, { projectId: PROJECT, name: "cached" }, dep);
  const hmac = hmacForValue(created.body.value, process.env.PODS_KEY_PEPPER);
  const stored = await db.getApiKeyByHmac(hmac);
  assert.equal(stored.id, created.body.id);

  const plan = await seedPlan(db);
  await addPlanStage(db, ADMIN, { projectId: PROJECT, planId: plan.id, apiId: api.id, stage: "prod" }, dep);
  await addKeyToPlan(db, ADMIN, { projectId: PROJECT, planId: plan.id, keyId: created.body.id }, dep);
  const cached = JSON.parse(await kv.get(`apikey:${hmac}`));
  assert.equal(cached.keyId, created.body.id);
  assert.equal(cached.plans.length, 1);
  assert.equal(cached.plans[0].apiId, api.id);
});
