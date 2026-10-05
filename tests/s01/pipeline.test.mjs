import assert from "node:assert/strict";
import test from "node:test";

import { GatewayError } from "../../lib/gateway/core/errors.mjs";
import { PHASE_ORDER, PHASES } from "../../lib/gateway/core/phases/index.mjs";
import { runPhases } from "../../lib/gateway/core/pipeline.mjs";

function stubCtx() {
  return {
    requestId: "req-test-1",
    context: { requestId: "req-test-1" },
    artifact: {},
    ports: { log() {} },
  };
}

function phase(name, behavior) {
  return {
    name,
    async run(ctx) {
      ctx.calls.push(name);
      return behavior?.(ctx);
    },
  };
}

test("S01: pipeline runs phases in the documented order and stops at the first Response", async () => {
  const stop = new Response("stop");
  const ctx = { ...stubCtx(), calls: [] };
  const phases = [
    phase("receive"),
    phase("match", () => stop),
    phase("invoke"),
    phase("emit"),
  ];
  const out = await runPhases(ctx, phases);
  assert.equal(out, stop);
  assert.deepEqual(ctx.calls, ["receive", "match", "emit"]);
});

test("S01: pipeline short-circuits on GatewayError and still runs emit", async () => {
  const ctx = { ...stubCtx(), calls: [] };
  const phases = [
    phase("authorize", () => {
      throw new GatewayError("THROTTLED");
    }),
    phase("invoke"),
    phase("emit"),
  ];
  const out = await runPhases(ctx, phases);
  assert.ok(out instanceof Response);
  assert.equal(out.status, 429);
  assert.deepEqual(ctx.calls, ["authorize", "emit"]);
});

test("S01: registered phases match the documented 20-step order", () => {
  assert.equal(PHASES.length, 20);
  assert.deepEqual(PHASE_ORDER, [
    "receive",
    "resolveEndpoint",
    "endpointAccess",
    "waf",
    "match",
    "cors",
    "canary",
    "resourcePolicy:pre",
    "authorize",
    "resourcePolicy:post",
    "apiKey",
    "throttle",
    "quota",
    "validate",
    "cacheLookup",
    "integrationRequest",
    "invoke",
    "integrationResponse",
    "methodResponse",
    "emit",
  ]);
  for (const mod of PHASES) {
    assert.equal(typeof mod.name, "string");
    assert.equal(typeof mod.run, "function");
  }
});
