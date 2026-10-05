import assert from "node:assert/strict";
import test from "node:test";

import { supports } from "../../lib/gateway/capabilities.mjs";
import { buildContext, resolveVariable } from "../../lib/gateway/core/context.mjs";
import { GatewayError } from "../../lib/gateway/core/errors.mjs";
import { exceedsHeaderLimit } from "../../lib/gateway/core/limits.mjs";
import { MemoryKvStore } from "../../lib/gateway/state/memory-kv.mjs";

test("S01 review: supports returns false for prototype-chain keys instead of throwing", () => {
  for (const key of ["__proto__", "constructor", "hasOwnProperty", "toString", "valueOf"]) {
    assert.equal(supports("REST", key), false, `supports("REST", ${key})`);
    assert.equal(supports("HTTP", key), false, `supports("HTTP", ${key})`);
  }
  assert.equal(supports("REST", "usage.apiKeys"), true);
});

test("S01 review: GatewayError rejects prototype-chain types", () => {
  for (const type of ["__proto__", "constructor", "prototype"]) {
    assert.throws(() => new GatewayError(type), TypeError, `GatewayError(${type})`);
  }
  assert.throws(() => new GatewayError("NOPE"), TypeError);
  assert.equal(new GatewayError("THROTTLED").statusCode, 429);
});

test("S01 review: context resolver returns empty string for prototype-chain paths", () => {
  const ctx = {
    context: {
      requestId: "r1",
      identity: { sourceIp: "10.0.0.1" },
      error: { message: "Too Many Requests" },
    },
    stageVariables: { name: "prod" },
  };
  for (const name of [
    "context.constructor",
    "context.hasOwnProperty",
    "context.toString",
    "context.valueOf",
    "context.__proto__",
    "context.identity.constructor",
    "stageVariables.constructor",
    "stageVariables.__proto__",
    "$context.constructor",
  ]) {
    assert.equal(resolveVariable(ctx, name), "", name);
  }
  // Legitimate values keep working, including numbers.
  assert.equal(resolveVariable(ctx, "context.identity.sourceIp"), "10.0.0.1");
  assert.equal(resolveVariable(ctx, "$stageVariables.name"), "prod");
  const full = buildContext(new Request("https://gw.example/items"), {}, {});
  assert.equal(resolveVariable(full, "context.requestTimeEpoch"), String(full.context.requestTimeEpoch));
});

test("S01 review: header limit counts UTF-8 bytes not UTF-16 characters", () => {
  const headers = new Headers();
  // 6000 chars but 12000 bytes in UTF-8 — over the 10240-byte value limit.
  headers.set("x-big", "é".repeat(6000));
  assert.equal(exceedsHeaderLimit(headers), true);
  const ascii = new Headers();
  ascii.set("x-big", "a".repeat(10241));
  assert.equal(exceedsHeaderLimit(ascii), true);
  const ok = new Headers();
  ok.set("x-big", "é".repeat(100));
  assert.equal(exceedsHeaderLimit(ok), false);
});

test("S01 review: memory incrBy keeps existing TTL unless overridden", async () => {
  let now = 1_000_000;
  const kv = new MemoryKvStore({ clock: { now: () => now } });
  await kv.set("n", "10", { ttlMs: 1000 });
  assert.equal(await kv.incrBy("n", 5), 15);
  now += 500;
  assert.equal(await kv.get("n"), "15");
  now += 600;
  assert.equal(await kv.get("n"), null);
  // Explicit ttlMs overrides the previous TTL.
  await kv.set("m", "0", { ttlMs: 100_000 });
  assert.equal(await kv.incrBy("m", 1, { ttlMs: 1000 }), 1);
  now += 1500;
  assert.equal(await kv.get("m"), null);
});
