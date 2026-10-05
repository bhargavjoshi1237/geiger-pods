import assert from "node:assert/strict";
import test from "node:test";

import { GatewayError } from "../../lib/gateway/core/errors.mjs";
import { renderGatewayError } from "../../lib/gateway/core/gateway-responses.mjs";

test('S01: GatewayError(THROTTLED) renders 429 {"message":"Too Many Requests"} with x-pods-error-type', async () => {
  const err = new GatewayError("THROTTLED");
  assert.equal(err.statusCode, 429);
  const res = renderGatewayError(err, { requestId: "req-1" });
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("content-type"), "application/json");
  assert.equal(res.headers.get("x-pods-error-type"), "THROTTLED");
  assert.equal(res.headers.get("x-pods-request-id"), "req-1");
  assert.deepEqual(await res.json(), { message: "Too Many Requests" });
});

test("S01: every response carries x-pods-request-id", async () => {
  for (const type of ["UNAUTHORIZED", "MISSING_AUTHENTICATION_TOKEN", "RESOURCE_NOT_FOUND"]) {
    const res = renderGatewayError(new GatewayError(type), { requestId: "req-abc" });
    assert.equal(res.headers.get("x-pods-request-id"), "req-abc");
  }
  const fallback = renderGatewayError(new GatewayError("THROTTLED"), {});
  assert.equal(fallback.headers.get("x-pods-request-id"), "");
});
