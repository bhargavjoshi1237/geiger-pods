/**
 * S06W runtime: custom gateway responses — a customized type renders its
 * status/header/template; an uncustomized type falls back to the
 * `DEFAULT_4XX`/`DEFAULT_5XX` customization. The THROTTLED customization
 * itself is exercised directly (the throttle phase is another spec's stub,
 * so the pipeline cannot emit THROTTLED yet).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { renderCustomGatewayResponse } from "../../lib/gateway/core/gateway-responses.mjs";
import { startUpstream } from "../fixtures/upstream.mjs";
import { compileOrThrow, restDraft } from "./helper.mjs";
import { serveArtifact } from "./serve.mjs";

const RESOURCES = [
  { id: "res-root", path: "/" },
  { id: "res-items", path: "/pets" },
];

const PET_MODEL = {
  name: "Pet",
  schema: {
    type: "object",
    required: ["name"],
    properties: { name: { type: "string" } },
  },
};

function validatedDraft(upstreamUrl, apiPublicId, gatewayResponses) {
  return restDraft(upstreamUrl, {
    apiPublicId,
    resources: RESOURCES,
    method: {
      httpMethod: "POST",
      requestValidatorId: "all",
      requestModels: { "application/json": "Pet" },
    },
    validators: [
      { name: "all", validate_request_body: true, validate_request_parameters: false },
    ],
    models: [PET_MODEL],
    extra: { gatewayResponses },
  });
}

async function postInvalid(baseUrl) {
  return fetch(`${baseUrl}/pets`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ age: 1 }),
  });
}

test("S06W: custom THROTTLED response status/header/template; DEFAULT_4XX fallback", async () => {
  const customizations = [
    {
      response_type: "THROTTLED",
      status_code: "429",
      response_parameters: { "gatewayresponse.header.X-Limit": "'slow-down'" },
      response_templates: { "application/json": '{"retry":true}' },
    },
    {
      response_type: "DEFAULT_4XX",
      status_code: "400",
      response_parameters: { "gatewayresponse.header.X-Fallback": "'d4xx'" },
      response_templates: { "application/json": '{"fallback":true}' },
    },
  ];
  const ctx = { requestId: "req-1", context: { requestId: "req-1", error: {} }, stageVariables: {} };

  const throttled = await renderCustomGatewayResponse(
    { type: "THROTTLED", message: "Too Many Requests" }, ctx, customizations, {},
  );
  assert.equal(throttled.status, 429);
  assert.equal(throttled.headers.get("x-limit"), "slow-down");
  assert.deepEqual(await throttled.json(), { retry: true });

  // Unspecified 4xx type falls back to the DEFAULT_4XX customization.
  const other = await renderCustomGatewayResponse(
    { type: "UNAUTHORIZED", message: "Unauthorized" }, ctx, customizations, {},
  );
  assert.equal(other.status, 400);
  assert.equal(other.headers.get("x-fallback"), "d4xx");
  assert.deepEqual(await other.json(), { fallback: true });
});

test("S06W: custom BAD_REQUEST_BODY status/header/template over the wire", async () => {
  const upstream = await startUpstream();
  try {
    const draft = validatedDraft(upstream.url, "s06wgw00000001", [{
      response_type: "BAD_REQUEST_BODY",
      status_code: "422",
      response_parameters: { "gatewayresponse.header.X-Reason": "'bad-body'" },
      response_templates: { "application/json": '{"code":"E_BAD"}' },
    }]);
    const artifact = compileOrThrow(draft);
    const { gateway, baseUrl } = await serveArtifact(artifact, { stage: "prod" });
    try {
      const response = await postInvalid(baseUrl);
      assert.equal(response.status, 422);
      assert.equal(response.headers.get("x-pods-error-type"), "BAD_REQUEST_BODY");
      assert.equal(response.headers.get("x-reason"), "bad-body");
      assert.deepEqual(await response.json(), { code: "E_BAD" });
      // No integration call: validation rejects before invoke.
      assert.equal(upstream.requests.length, 0);
    } finally {
      await gateway.close();
    }
  } finally {
    await upstream.close();
  }
});

test("S06W: unspecified type falls back to DEFAULT_4XX customization over the wire", async () => {
  const upstream = await startUpstream();
  try {
    const draft = validatedDraft(upstream.url, "s06wgw00000002", [{
      response_type: "DEFAULT_4XX",
      status_code: "400",
      response_parameters: { "gatewayresponse.header.X-Fallback": "'d4xx'" },
      response_templates: { "application/json": '{"fallback":true}' },
    }]);
    const artifact = compileOrThrow(draft);
    const { gateway, baseUrl } = await serveArtifact(artifact, { stage: "prod" });
    try {
      const response = await postInvalid(baseUrl);
      assert.equal(response.status, 400);
      assert.equal(response.headers.get("x-fallback"), "d4xx");
      assert.deepEqual(await response.json(), { fallback: true });
    } finally {
      await gateway.close();
    }
  } finally {
    await upstream.close();
  }
});
