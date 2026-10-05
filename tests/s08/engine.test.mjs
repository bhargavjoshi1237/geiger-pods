/**
 * S08 engine acceptance tests: key check (phase 11), throttling (phase 12)
 * and quotas (phase 13). The phases are driven directly (`run(ctx)`) with a
 * hand-built context — the full pipeline registry is owned by S01/S07 and
 * currently broken by in-flight S07 work, which S08 must not touch.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { GatewayError } from "../../lib/gateway/core/errors.mjs";
import { MemoryKvStore } from "../../lib/gateway/state/memory-kv.mjs";
import {
  APIKEY_CACHE_TTL_MS,
  USAGE_CHANGED_CHANNEL,
  apiKeyCacheKey,
  assertImportableValue,
  attachUsageInvalidation,
  extractCandidateKey,
  findCoveringPlan,
  generateApiKeyValue,
  hmacForValue,
  keyPrefix,
  lookupKeyRecord,
} from "../../lib/gateway/core/usage/api-key.mjs";
import {
  applyQuotaAdjustment,
  baseAllowance,
  effectiveAllowance,
  formatPeriodDay,
  formatUsage,
  parseUsageDay,
  periodEndMs,
  periodStartFor,
  quotaAllowanceKey,
  quotaCounterKey,
  buildUsageMeteringEvent,
} from "../../lib/gateway/core/usage/quota.mjs";
import { run as runApiKey } from "../../lib/gateway/core/phases/api-key.mjs";
import { run as runThrottle } from "../../lib/gateway/core/phases/throttle.mjs";
import { run as runQuota } from "../../lib/gateway/core/phases/quota.mjs";

const PEPPER = "test-pepper-s08";
const DAY = 24 * 60 * 60 * 1000;

function mutableClock(startMs) {
  const state = { nowMs: startMs };
  return {
    state,
    clock: { now: () => state.nowMs },
  };
}

function makeKv(clock) {
  return new MemoryKvStore({ clock });
}

function baseContext({ artifact, usage, usageKey, headers = {}, authorizer, match, kv, clock, url = "https://gw.example/pets" }) {
  const request = new Request(url, { headers });
  return {
    request,
    artifact,
    ports: { kv, clock, log() {}, events: { emit() {} } },
    context: {
      requestId: "req-1",
      accountId: artifact.projectId ?? "",
      apiKey: "",
      identity: { apiKey: "", apiKeyId: "" },
      authorizer: {},
      error: { message: "", messageString: '""', responseType: "" },
    },
    authorizer,
    match,
    usage,
    usageKey,
  };
}

function restArtifact({ apiKeySource = "HEADER", apiKeyRequired = true } = {}) {
  return {
    protocol: "REST",
    projectId: "proj-1",
    apiId: "api-uuid-1",
    apiPublicId: "a1b2c3d4e5",
    stage: "prod",
    settings: { apiKeySource },
    resources: [{
      id: "r1",
      path: "/pets",
      methods: { GET: { id: "m1", apiKeyRequired } },
    }],
    restMethods: [{ id: "m1", resourceId: "r1", httpMethod: "GET" }],
  };
}

function restMatch() {
  return { resourceId: "r1", resourcePath: "/pets", methodId: "m1", httpMethod: "GET", pathParameters: {} };
}

function planEntry({ planId = "plan-1", apiId = "api-uuid-1", stage = "prod", throttle = null, quota = null, methodThrottles = {} } = {}) {
  return { planId, apiId, stage, throttle, quota, methodThrottles };
}

function keyRecord({ keyId = "key-1", enabled = true, plans = [planEntry()] } = {}) {
  return { keyId, publicId: "k123456789", enabled, plans };
}

function keyedCtx({ value = "A".repeat(40), artifact = restArtifact(), plans, enabled = true, clockMs = Date.UTC(2026, 9, 4, 12, 0, 0), headers = null, extraUsage = {} } = {}) {
  const { state, clock } = mutableClock(clockMs);
  const kv = makeKv(clock);
  const hmac = hmacForValue(value, PEPPER);
  const usage = {
    pepper: PEPPER,
    keys: { [hmac]: keyRecord({ plans: plans ?? [planEntry()], enabled }) },
    project: { rate: 10000, burst: 5000 },
    ...extraUsage,
  };
  const ctx = baseContext({
    artifact,
    usage,
    headers: headers ?? { "x-api-key": value },
    match: restMatch(),
    kv,
    clock,
  });
  return { ctx, kv, clock: state, hmac, value };
}

async function assertGatewayError(promise, type, status) {
  await assert.rejects(
    promise,
    (error) => {
      assert.ok(error instanceof GatewayError, `expected GatewayError, got ${error}`);
      assert.equal(error.type, type);
      if (status !== undefined) assert.equal(error.statusCode, status);
      return true;
    },
  );
}

// --- Key value rules (spec §1) ---

test("S08: generated values are 40-char base62; imports must be 20-128 [A-Za-z0-9_-]", () => {
  const generated = generateApiKeyValue();
  assert.equal(generated.length, 40);
  assert.match(generated, /^[A-Za-z0-9]{40}$/);
  const others = new Set([generated, generateApiKeyValue(), generateApiKeyValue()]);
  assert.equal(others.size, 3);

  assert.equal(assertImportableValue("abcDEF012-_xyzABCDEF"), "abcDEF012-_xyzABCDEF");
  assert.throws(() => assertImportableValue("too-short"), /20–128/);
  assert.throws(() => assertImportableValue("x".repeat(129)), /20–128/);
  assert.throws(() => assertImportableValue("has space in it 123456"), /20–128/);
  assert.throws(() => assertImportableValue("semi;colon-value-1234"), /20–128/);

  assert.equal(keyPrefix("abcdef123456"), "abcdef");
  const digest = hmacForValue("some-value", PEPPER);
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.equal(hmacForValue("some-value", PEPPER), digest);
  assert.notEqual(hmacForValue("some-value", "other-pepper"), digest);
  assert.throws(() => hmacForValue("some-value", ""), /PODS_KEY_PEPPER/);
});

// --- Key check (phase 11, spec §3) ---

test("S08: missing key, unknown key, disabled key, key not in a plan for this stage → 403 Forbidden", async () => {
  // Missing.
  {
    const { ctx } = keyedCtx({ headers: {} });
    await assertGatewayError(runApiKey(ctx), "INVALID_API_KEY", 403);
  }
  // Unknown.
  {
    const { ctx } = keyedCtx({ value: "B".repeat(40) });
    ctx.usage.keys = {};
    await assertGatewayError(runApiKey(ctx), "INVALID_API_KEY", 403);
  }
  // Disabled.
  {
    const { ctx } = keyedCtx({ enabled: false });
    await assertGatewayError(runApiKey(ctx), "INVALID_API_KEY", 403);
  }
  // No plan covering this stage.
  {
    const { ctx } = keyedCtx({ plans: [planEntry({ stage: "dev" })] });
    await assertGatewayError(runApiKey(ctx), "INVALID_API_KEY", 403);
  }
  // Happy path sets $context identity + usageKey.
  {
    const { ctx, value } = keyedCtx();
    await runApiKey(ctx);
    assert.equal(ctx.context.identity.apiKey, value);
    assert.equal(ctx.context.identity.apiKeyId, "key-1");
    assert.equal(ctx.usageKey.keyId, "key-1");
    assert.equal(ctx.usageKey.plan.planId, "plan-1");
  }
});

test("S08: no key required → phase is a no-op (even with no key present)", async () => {
  const { ctx } = keyedCtx({ artifact: restArtifact({ apiKeyRequired: false }), headers: {} });
  await runApiKey(ctx);
  assert.equal(ctx.usageKey, undefined);
});

test("S08: AUTHORIZER key source uses usageIdentifierKey from custom authorizer", async () => {
  const artifact = restArtifact({ apiKeySource: "AUTHORIZER" });
  const value = "C".repeat(40);
  // From ctx.authorizer (S07 custom authorizer contract).
  {
    const built = keyedCtx({ value, artifact, headers: {} });
    built.ctx.authorizer = { usageIdentifierKey: value };
    await runApiKey(built.ctx);
    assert.equal(built.ctx.usageKey.keyId, "key-1");
  }
  // From ctx.context.authorizer (alternate placement) also works.
  {
    const built = keyedCtx({ value, artifact, headers: {} });
    built.ctx.context.authorizer.usageIdentifierKey = value;
    await runApiKey(built.ctx);
    assert.equal(built.ctx.usageKey.keyId, "key-1");
  }
  // Absent → 403 (S07 produced no identifier).
  {
    const built = keyedCtx({ value, artifact, headers: {} });
    await assertGatewayError(runApiKey(built.ctx), "INVALID_API_KEY", 403);
  }
  // A header value is ignored under AUTHORIZER source.
  {
    const built = keyedCtx({ value: "D".repeat(40), artifact, headers: { "x-api-key": value } });
    await assertGatewayError(runApiKey(built.ctx), "INVALID_API_KEY", 403);
  }
});

test("S08: extractCandidateKey + findCoveringPlan unit behavior", () => {
  const headerCtx = baseContext({
    artifact: restArtifact(), usage: null, headers: { "x-api-key": "v" }, match: null, kv: null, clock: { now: () => 0 },
  });
  assert.equal(extractCandidateKey(headerCtx), "v");
  assert.equal(findCoveringPlan(null, "a", "s"), null);
  assert.equal(findCoveringPlan({ plans: [] }, "a", "s"), null);
  const record = { plans: [planEntry({ planId: "p1" }), planEntry({ planId: "p2", stage: "dev" })] };
  assert.equal(findCoveringPlan(record, "api-uuid-1", "prod").planId, "p1");
});

test("S08: key lookup caches in KV for 60 s and invalidates on pods:usage-changed without redeploy", async () => {
  const { ctx, kv, clock, hmac, value } = keyedCtx();
  const release = attachUsageInvalidation(kv);
  try {
    await runApiKey(ctx);
    const cached = await kv.get(apiKeyCacheKey(hmac));
    assert.ok(cached, "lookup populates the KV cache");
    assert.equal(JSON.parse(cached).keyId, "key-1");

    // Disable in the backing snapshot, then publish the change: the next
    // request must 403 even though the artifact never changed (no redeploy).
    ctx.usage.keys[hmac].enabled = false;
    await kv.publish(USAGE_CHANGED_CHANNEL, JSON.stringify({ hmac }));
    await assertGatewayError(runApiKey(ctx), "INVALID_API_KEY", 403);
  } finally {
    release();
  }

  // TTL-only path (no pub/sub): stale entry allows until it expires.
  const stale = keyedCtx({ value });
  await runApiKey(stale.ctx);
  stale.ctx.usage.keys[stale.hmac].enabled = false;
  await runApiKey(stale.ctx); // still cached → allowed
  stale.clock.nowMs += APIKEY_CACHE_TTL_MS + 1000;
  await assertGatewayError(runApiKey(stale.ctx), "INVALID_API_KEY", 403);
});

test("S08: lookupKeyRecord falls back to the usage.lookup read-through and repopulates KV", async () => {
  const { state, clock } = mutableClock(Date.UTC(2026, 9, 4, 12, 0, 0));
  void state;
  const kv = makeKv(clock);
  const value = "E".repeat(40);
  const hmac = hmacForValue(value, PEPPER);
  const record = keyRecord();
  const ctx = baseContext({
    artifact: restArtifact(),
    usage: { pepper: PEPPER, lookup: async (asked) => (asked === hmac ? record : null) },
    headers: { "x-api-key": value },
    match: restMatch(),
    kv,
    clock,
  });
  assert.deepEqual(await lookupKeyRecord(ctx, hmac), record);
  assert.ok(await kv.get(apiKeyCacheKey(hmac)), "read-through repopulates the cache");
  assert.equal(await lookupKeyRecord(ctx, hmacForValue("F".repeat(40), PEPPER)), null);
});

// --- Throttling (phase 12, spec §4) ---

function throttleCtx({ plan = null, stage = undefined, project = { rate: 10000, burst: 5000 }, clockMs = Date.UTC(2026, 9, 4, 12, 0, 0), kv = null, clockObj = null } = {}) {
  const holder = clockObj ?? mutableClock(clockMs);
  const state = holder.state ?? null;
  const clock = holder.clock ?? holder;
  const store = kv ?? makeKv(clock);
  const ctx = baseContext({
    artifact: restArtifact(),
    usage: {
      pepper: PEPPER,
      project,
      ...(stage === undefined ? {} : { stage }),
    },
    usageKey: plan ? { keyId: "key-1", plan } : undefined,
    headers: {},
    match: restMatch(),
    kv: store,
    clock,
  });
  return { ctx, kv: store, clockState: state };
}

test("S08: token bucket order — per-key-per-method limit 1 rps rejects while stage limit 100 allows", async () => {
  const { ctx } = throttleCtx({
    plan: planEntry({
      throttle: { rateLimit: 100, burstLimit: 100 },
      methodThrottles: { "/pets/GET": { rateLimit: 1, burstLimit: 1 } },
    }),
    stage: { method_settings: {}, default_route_settings: { rate: 100, burst: 100 } },
  });
  await runThrottle(ctx);
  await assertGatewayError(runThrottle(ctx), "THROTTLED", 429);
  assert.equal(ctx.throttled, true);
});

test("S08: project limit applies across two APIs", async () => {
  const { state, clock } = mutableClock(Date.UTC(2026, 9, 4, 12, 0, 0));
  void state;
  const kv = makeKv(clock);
  const project = { rate: 2, burst: 2 };
  const first = throttleCtx({ project, kv, clockObj: { state, clock } });
  const secondArtifact = { ...restArtifact(), apiId: "api-uuid-2", apiPublicId: "f9f9f9f9f9" };
  const second = throttleCtx({ project, kv, clockObj: { state, clock } });
  second.ctx.artifact = secondArtifact;

  await runThrottle(first.ctx);
  await runThrottle(first.ctx);
  await assertGatewayError(runThrottle(second.ctx), "THROTTLED", 429);
});

test("S08: throttle 0/0 on route → 429", async () => {
  const zeroStage = throttleCtx({
    stage: { method_settings: { "/pets/GET": { rate: 0, burst: 0 } } },
  });
  await assertGatewayError(runThrottle(zeroStage.ctx), "THROTTLED", 429);

  const zeroProject = throttleCtx({ project: { rate: 0, burst: 0 } });
  await assertGatewayError(runThrottle(zeroProject.ctx), "THROTTLED", 429);

  const zeroPlan = throttleCtx({ plan: planEntry({ throttle: { rateLimit: 0, burstLimit: 0 } }) });
  await assertGatewayError(runThrottle(zeroPlan.ctx), "THROTTLED", 429);
});

test("S08: KV outage → throttle falls back to local bucket (open) or 429 (closed)", async () => {
  const failingKv = {
    async get() { throw new Error("kv down"); },
    async set() { throw new Error("kv down"); },
    async del() { throw new Error("kv down"); },
    async incrBy() { throw new Error("kv down"); },
    async tokenBucket() { throw new Error("kv down"); },
  };
  const open = throttleCtx({ kv: failingKv });
  await runThrottle(open.ctx);
  assert.equal(open.ctx.kvFallback, true);

  const closed = throttleCtx({ kv: failingKv, project: { rate: 10000, burst: 5000, throttleKvFailure: "closed" } });
  await assertGatewayError(runThrottle(closed.ctx), "THROTTLED", 429);
});

test("S08: rate-limit headers are off by default and on with features.rateLimitHeaders", async () => {
  const plain = throttleCtx({ plan: planEntry({ throttle: { rateLimit: 1, burstLimit: 1 } }) });
  await runThrottle(plain.ctx);
  // Default: throws (no Response with headers).
  await assertGatewayError(runThrottle(plain.ctx), "THROTTLED", 429);

  const { state, clock } = mutableClock(Date.UTC(2026, 9, 4, 12, 0, 0));
  void state;
  const kv = makeKv(clock);
  const project = { rate: 10000, burst: 5000, features: { rateLimitHeaders: true } };
  const first = throttleCtx({ project, plan: planEntry({ throttle: { rateLimit: 1, burstLimit: 1 } }), kv, clockObj: { state, clock } });
  await runThrottle(first.ctx);
  const response = await runThrottle(first.ctx);
  assert.ok(response instanceof Response);
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("x-pods-error-type"), "THROTTLED");
  assert.ok(response.headers.get("Retry-After"), "Retry-After present");
  assert.ok(response.headers.get("RateLimit-Limit"), "RateLimit-Limit present");
});

// --- Quotas (phase 13, spec §5) ---

function quotaCtx({ quota = { limit: 5, offset: 0, period: "DAY", since: null }, clockMs = Date.UTC(2026, 9, 4, 12, 0, 0), kv = null, clockObj = null, project = {} } = {}) {
  const holder = clockObj ?? mutableClock(clockMs);
  const state = holder.state ?? null;
  const clock = holder.clock ?? holder;
  const store = kv ?? makeKv(clock);
  const plan = planEntry({ quota });
  const ctx = baseContext({
    artifact: restArtifact(),
    usage: { pepper: PEPPER, project },
    usageKey: { keyId: "key-1", plan },
    headers: {},
    match: restMatch(),
    kv: store,
    clock,
  });
  return { ctx, kv: store, clockState: state, plan };
}

test("S08: DAY quota of 5 → sixth request 429 Limit Exceeded; resets at 00:00 UTC", async () => {
  const midnight = Date.UTC(2026, 9, 4, 0, 0, 0);
  const { state, clock } = mutableClock(midnight + 12 * 60 * 60 * 1000);
  const kv = makeKv(clock);
  const holder = { state, clock };
  const first = quotaCtx({ kv, clockObj: holder });
  for (let index = 0; index < 5; index += 1) {
    await runQuota(first.ctx);
  }
  await assertGatewayError(runQuota(first.ctx), "QUOTA_EXCEEDED", 429);
  assert.equal(first.ctx.quotaRejected, true);
  const body = await first.ctx.quotaRejected ? null : null;
  void body;

  // The rejection body is {"message":"Limit Exceeded"} via the catalog.
  try {
    await runQuota(first.ctx);
    assert.fail("expected QUOTA_EXCEEDED");
  } catch (error) {
    assert.ok(error instanceof GatewayError);
    assert.equal(error.message, "Limit Exceeded");
  }

  // Past midnight UTC the counter key rolls over.
  state.nowMs = midnight + DAY + 1000;
  await runQuota(first.ctx);
  const metering = buildUsageMeteringEvent(first.ctx);
  assert.equal(metering.planId, "plan-1");
  assert.equal(metering.keyId, "key-1");
});

test("S08: WEEK starts Sunday and MONTH starts day 1 (UTC)", () => {
  // 2026-10-04 is a Sunday.
  assert.equal(formatPeriodDay(periodStartFor("WEEK", Date.UTC(2026, 9, 4, 12))), "2026-10-04");
  assert.equal(formatPeriodDay(periodStartFor("WEEK", Date.UTC(2026, 9, 5, 12))), "2026-10-04");
  assert.equal(formatPeriodDay(periodStartFor("WEEK", Date.UTC(2026, 9, 3, 12))), "2026-09-27");
  assert.equal(formatPeriodDay(periodStartFor("MONTH", Date.UTC(2026, 9, 15))), "2026-10-01");
  assert.equal(formatPeriodDay(periodStartFor("MONTH", Date.UTC(2026, 10, 1))), "2026-11-01");
  assert.equal(formatPeriodDay(periodStartFor("DAY", Date.UTC(2026, 9, 4, 23, 59))), "2026-10-04");
  assert.equal(periodEndMs("DAY", Date.UTC(2026, 9, 4)) - Date.UTC(2026, 9, 4), DAY);
  assert.equal(periodEndMs("WEEK", Date.UTC(2026, 9, 4)) - Date.UTC(2026, 9, 4), 7 * DAY);
  assert.equal(parseUsageDay("2026-10-04"), Date.UTC(2026, 9, 4));
  assert.throws(() => parseUsageDay("04-10-2026"), /YYYY-MM-DD/);
  assert.equal(quotaCounterKey("p", "k", 123), "q:p:k:123");
  assert.equal(quotaAllowanceKey("p", "k", 123), "qa:p:k:123");
});

test("S08: quota offset applies only to the initial period", async () => {
  const dayOne = Date.UTC(2026, 9, 4, 10, 0, 0);
  const quota = { limit: 5, offset: 2, period: "DAY", since: dayOne };
  assert.equal(baseAllowance(quota, periodStartFor("DAY", dayOne)), 3);
  assert.equal(baseAllowance(quota, periodStartFor("DAY", dayOne + DAY)), 5);

  const { state, clock } = mutableClock(dayOne);
  const kv = makeKv(clock);
  const holder = { state, clock };
  const ctx = quotaCtx({ quota, kv, clockObj: holder });
  for (let index = 0; index < 3; index += 1) await runQuota(ctx.ctx);
  await assertGatewayError(runQuota(ctx.ctx), "QUOTA_EXCEEDED", 429);

  state.nowMs = dayOne + DAY; // next period: full limit again
  for (let index = 0; index < 5; index += 1) await runQuota(ctx.ctx);
  await assertGatewayError(runQuota(ctx.ctx), "QUOTA_EXCEEDED", 429);
});

test("S08: extend usage +10 lets 10 more requests through today; reset restores full limit", async () => {
  const { state, clock } = mutableClock(Date.UTC(2026, 9, 4, 12, 0, 0));
  const kv = makeKv(clock);
  const holder = { state, clock };
  const built = quotaCtx({ kv, clockObj: holder });
  const { ctx, plan } = built;
  for (let index = 0; index < 5; index += 1) await runQuota(ctx);
  await assertGatewayError(runQuota(ctx), "QUOTA_EXCEEDED", 429);

  const periodStart = periodStartFor("DAY", state.nowMs);
  const used = Number(await kv.get(quotaCounterKey("plan-1", "key-1", periodStart)));
  assert.equal(used, 6); // the rejected attempt is kept, per AWS
  const extended = applyQuotaAdjustment("extend", 10, { used, allowance: 5, limit: 5 });
  assert.equal(extended, 15);
  await kv.set(quotaAllowanceKey("plan-1", "key-1", periodStart), String(extended));
  for (let index = 0; index < 9; index += 1) await runQuota(ctx);
  await assertGatewayError(runQuota(ctx), "QUOTA_EXCEEDED", 429);

  const usedAfter = Number(await kv.get(quotaCounterKey("plan-1", "key-1", periodStart)));
  const reset = applyQuotaAdjustment("reset", 0, { used: usedAfter, allowance: 15, limit: 5 });
  assert.equal(reset, usedAfter + 5);
  await kv.set(quotaAllowanceKey("plan-1", "key-1", periodStart), String(reset));
  for (let index = 0; index < 5; index += 1) await runQuota(ctx);
  await assertGatewayError(runQuota(ctx), "QUOTA_EXCEEDED", 429);

  const set = applyQuotaAdjustment("set", 2, { used: usedAfter + 6, allowance: reset, limit: 5 });
  assert.equal(set, usedAfter + 8);
  assert.throws(() => applyQuotaAdjustment("bogus", 1, { used: 0, allowance: 5, limit: 5 }), /extend\|reset\|set/);
  void plan;
});

test("S08: effectiveAllowance prefers the KV override, else base + snapshot delta", () => {
  const plan = { quota: { limit: 5, offset: 0, period: "DAY", since: null }, adjustmentsDelta: 3 };
  const start = periodStartFor("DAY", Date.UTC(2026, 9, 4, 12));
  assert.equal(effectiveAllowance(plan, start, null), 8);
  assert.equal(effectiveAllowance(plan, start, 42), 42);
  assert.equal(effectiveAllowance(plan, start, Number.NaN), 8);
});

test("S08: GetUsage returns AWS-shaped items with used/remaining per day", () => {
  const shaped = formatUsage({
    usagePlanId: "plan-1",
    startDate: "2026-10-01",
    endDate: "2026-10-02",
    series: { "key-1": [[3, 2], [0, 5]] },
  });
  assert.deepEqual(shaped, {
    usagePlanId: "plan-1",
    startDate: "2026-10-01",
    endDate: "2026-10-02",
    items: { "key-1": [[3, 2], [0, 5]] },
    position: null,
  });
});

test("S08: KV outage → quota fails closed by default, open with quotaFailOpen", async () => {
  const failingKv = {
    async get() { throw new Error("kv down"); },
    async set() { throw new Error("kv down"); },
    async del() { throw new Error("kv down"); },
    async incrBy() { throw new Error("kv down"); },
    async tokenBucket() { throw new Error("kv down"); },
  };
  const closed = quotaCtx({ kv: failingKv });
  await assertGatewayError(runQuota(closed.ctx), "QUOTA_EXCEEDED", 429);

  const open = quotaCtx({ kv: failingKv, project: { features: { quotaFailOpen: true } } });
  await runQuota(open.ctx);
  assert.equal(open.ctx.kvFallback, true);
});

test("S08: HTTP APIs never enforce keys (capability usage.apiKeys is REST+WS only)", async () => {
  const { state, clock } = mutableClock(Date.UTC(2026, 9, 4, 12, 0, 0));
  void state;
  const kv = makeKv(clock);
  const ctx = baseContext({
    artifact: { protocol: "HTTP", projectId: "proj-1", apiId: "api-uuid-1", stage: "$default" },
    usage: { pepper: PEPPER },
    headers: {},
    match: { routeId: "rt1", routeKey: "GET /pets", pathParameters: {} },
    kv,
    clock,
  });
  ctx.apiKeyRequired = true; // host override: still unenforced on HTTP
  await runApiKey(ctx);
  assert.equal(ctx.usageKey, undefined);
});
