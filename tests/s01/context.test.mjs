import assert from "node:assert/strict";
import test from "node:test";

import { buildContext, formatClfTime, resolveVariable } from "../../lib/gateway/core/context.mjs";

function stubCtx() {
  return {
    context: {
      requestId: "r1",
      identity: { sourceIp: "10.0.0.1" },
      error: { message: "Too Many Requests" },
    },
    stageVariables: { name: "prod" },
  };
}

test('S01: context resolver returns "" for unknown variables and quotes messageString', () => {
  const ctx = stubCtx();
  assert.equal(resolveVariable(ctx, "context.identity.sourceIp"), "10.0.0.1");
  assert.equal(resolveVariable(ctx, "context.nope.missing"), "");
  assert.equal(resolveVariable(ctx, "context.authorizer.somethingDeep"), "");
  assert.equal(resolveVariable(ctx, "bogus"), "");
  assert.equal(resolveVariable(ctx, ""), "");
  assert.equal(resolveVariable(ctx, "$stageVariables.name"), "prod");
  assert.equal(resolveVariable(ctx, "context.error.messageString"), '"Too Many Requests"');
  assert.equal(resolveVariable(ctx, "$context.error.messageString"), '"Too Many Requests"');
});

test("S01: requestTime uses CLF format in UTC", () => {
  assert.equal(formatClfTime(new Date("2026-01-02T03:04:05Z")), "02/Jan/2026:03:04:05 +0000");
  assert.equal(formatClfTime(Date.UTC(2026, 0, 2, 3, 4, 5)), "02/Jan/2026:03:04:05 +0000");
  const ctx = buildContext(
    new Request("https://gw.example/items"),
    { protocol: "REST", apiId: "a1b2c3d4e5", stage: "prod" },
    { clock: { now: () => Date.UTC(2026, 5, 15, 12, 30, 45) } },
  );
  assert.equal(ctx.context.requestTime, "15/Jun/2026:12:30:45 +0000");
  assert.equal(ctx.context.requestTimeEpoch, Date.UTC(2026, 5, 15, 12, 30, 45));
});
