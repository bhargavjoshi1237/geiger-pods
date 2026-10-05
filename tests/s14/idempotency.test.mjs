import assert from "node:assert/strict";
import test from "node:test";
import {
  checkIdempotency, recordIdempotency, hashBody,
  ControlRateLimiter, CONTROL_PLANE_LIMIT,
} from "../../lib/control/rate-limit.mjs";

function idemDb(store = new Map()) {
  return {
    async getIdempotency({ projectId, actorKey, key }) {
      return store.get(`${projectId}:${actorKey}:${key}`) ?? null;
    },
    async insertIdempotency(row) {
      store.set(`${row.project_id}:${row.actor_key}:${row.idempotency_key}`, {
        response_status: row.response_status, response_body: row.response_body,
        request_hash: row.request_hash, expires_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
      });
    },
  };
}

test("S14: Idempotency-Key replay returns identical response and creates one resource; different body → 422", async () => {
  const db = idemDb();
  let creates = 0;
  async function post({ projectId, actorKey, key, body }) {
    const checked = await checkIdempotency(db, { projectId, actorKey, key, body });
    if (checked.replayed) return { status: checked.status, body: checked.body, replayed: true };
    creates++;
    const response = { status: 201, body: { id: "api-1", name: body.name } };
    await recordIdempotency(db, { projectId, actorKey, key, body, status: response.status, responseBody: response.body });
    return { ...response, replayed: false };
  }
  const first = await post({ projectId: "p", actorKey: "u", key: "k-1", body: { name: "a" } });
  assert.equal(first.replayed, false);
  const second = await post({ projectId: "p", actorKey: "u", key: "k-1", body: { name: "a" } });
  assert.equal(second.replayed, true);
  assert.deepEqual(second.body, first.body);
  assert.equal(creates, 1);
  await assert.rejects(
    post({ projectId: "p", actorKey: "u", key: "k-1", body: { name: "b" } }),
    (error) => error.status === 422,
  );
  assert.equal(hashBody({ a: 1 }), hashBody({ a: 1 }));
});

test("S14: control-plane burst 40 then 429 with Retry-After", () => {
  let now = 0;
  const limiter = new ControlRateLimiter({ now: () => now });
  for (let i = 0; i < CONTROL_PLANE_LIMIT.burst; i++) {
    assert.equal(limiter.consume("proj").allowed, true);
  }
  const blocked = limiter.consume("proj");
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterMs > 0);
  // Other projects are unaffected.
  assert.equal(limiter.consume("other").allowed, true);
  // Refill after 1 s (10 tokens).
  now += 1000;
  for (let i = 0; i < 10; i++) assert.equal(limiter.consume("proj").allowed, true);
  assert.equal(limiter.consume("proj").allowed, false);
  // Heavy buckets: deployments 1/2 s per API.
  assert.equal(limiter.consumeHeavy("deployments.create", "api-1").allowed, true);
  const second = limiter.consumeHeavy("deployments.create", "api-1");
  assert.equal(second.allowed, false);
  assert.ok(second.retryAfterMs > 0);
  assert.equal(limiter.consumeHeavy("deployments.create", "api-2").allowed, true);
});
