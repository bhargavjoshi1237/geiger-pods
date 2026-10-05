import assert from "node:assert/strict";
import test from "node:test";

import {
  renderGatewayError,
  resolveGatewayCustomization,
  resolveGatewayParameter,
  renderCustomGatewayResponse,
} from "../../lib/gateway/core/gateway-responses.mjs";

const CUSTOM = [
  {
    response_type: "THROTTLED",
    status_code: "429",
    response_parameters: {
      "gatewayresponse.header.X-Retry": "'slow-down'",
      "gatewayresponse.header.X-Stage": "stageVariables.env",
      "gatewayresponse.header.X-Key": "method.request.header.X-Api-Key",
    },
    response_templates: {
      "application/json": '{"message": $context.error.messageString, "retry": true}',
    },
  },
  {
    response_type: "DEFAULT_4XX",
    status_code: "400",
    response_parameters: { "gatewayresponse.header.X-Fallback": "'fb'" },
    response_templates: {},
  },
];

test("S06: custom THROTTLED response status/header/template; unspecified type falls back to DEFAULT_4XX customization", async () => {
  // Resolution: exact type first, then DEFAULT_4XX/5XX by status class.
  assert.equal(resolveGatewayCustomization("THROTTLED", CUSTOM)?.response_type, "THROTTLED");
  assert.equal(resolveGatewayCustomization("UNAUTHORIZED", CUSTOM)?.response_type, "DEFAULT_4XX");
  assert.equal(resolveGatewayCustomization("INTEGRATION_TIMEOUT", CUSTOM), null);
  assert.equal(resolveGatewayCustomization("THROTTLED", []), null);

  // Parameter sources: static, stage variables, method request, context.
  const sources = {
    methodRequest: { headers: { "x-api-key": "abc" }, querystring: {}, path: {} },
    stageVariables: { env: "prod" },
    context: { stage: "prod" },
  };
  assert.equal(resolveGatewayParameter("'slow-down'", sources), "slow-down");
  assert.equal(resolveGatewayParameter("stageVariables.env", sources), "prod");
  assert.equal(resolveGatewayParameter("method.request.header.X-Api-Key", sources), "abc");
  assert.equal(resolveGatewayParameter("context.stage", sources), "prod");

  // Rendered custom THROTTLED: overridden status, mapped headers, template
  // body with $context.error.messageString.
  const response = await renderCustomGatewayResponse(
    { type: "THROTTLED", message: "Too Many Requests" },
    { requestId: "req-1", context: { requestId: "req-1" } },
    CUSTOM,
    {
      accept: "application/json",
      methodRequest: sources.methodRequest,
      stageVariables: sources.stageVariables,
    },
  );
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("x-retry"), "slow-down");
  assert.equal(response.headers.get("x-stage"), "prod");
  assert.equal(response.headers.get("x-key"), "abc");
  assert.equal(response.headers.get("x-pods-error-type"), "THROTTLED");
  assert.equal(response.headers.get("x-pods-request-id"), "req-1");
  assert.deepEqual(await response.json(), { message: "Too Many Requests", retry: true });

  // Unspecified 4xx type falls back to the DEFAULT_4XX customization.
  const fallback = await renderCustomGatewayResponse(
    { type: "UNAUTHORIZED", message: "Unauthorized" },
    { requestId: "req-2", context: { requestId: "req-2" } },
    CUSTOM,
    { accept: "application/json" },
  );
  assert.equal(fallback.status, 400);
  assert.equal(fallback.headers.get("x-fallback"), "fb");
  assert.deepEqual(await fallback.json(), { message: "Unauthorized" });

  // 5xx without DEFAULT_5XX keeps the built-in default.
  const plain = await renderCustomGatewayResponse(
    { type: "INTEGRATION_TIMEOUT" },
    { requestId: "req-3", context: { requestId: "req-3" } },
    CUSTOM,
    {},
  );
  assert.equal(plain.status, 504);
  assert.deepEqual(await plain.json(), { message: "Endpoint request timed out" });

  // No customizations at all → identical to the S01 default renderer.
  const builtin = await renderCustomGatewayResponse({ type: "THROTTLED" }, { requestId: "r" }, [], {});
  const expected = renderGatewayError({ type: "THROTTLED" }, { requestId: "r" });
  assert.equal(builtin.status, expected.status);
  assert.deepEqual(await builtin.json(), await expected.json());
});
