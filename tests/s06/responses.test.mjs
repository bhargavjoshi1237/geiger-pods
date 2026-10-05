import assert from "node:assert/strict";
import test from "node:test";

import {
  applyRequestOverrides,
  applyResponseOverrides,
  matchesSelectionPattern,
  selectIntegrationResponse,
  selectMockStatus,
} from "../../lib/gateway/core/processing/responses.mjs";
import { validateProcessing } from "../../lib/gateway/core/processing/validate-processing.mjs";

const RESPONSES = [
  { statusCode: "200", selectionPattern: "", responseParameters: {}, responseTemplates: {} },
  { statusCode: "400", selectionPattern: "4\\d\\d", responseParameters: {}, responseTemplates: {} },
  { statusCode: "500", selectionPattern: "5\\d\\d", responseParameters: {}, responseTemplates: {} },
];

test("S06: integration response selected by status regex; function errorMessage regex; default fallback; undeclared method response fails compile", () => {
  // Full-match semantics (Java matches(), not find()).
  assert.equal(matchesSelectionPattern("4\\d\\d", "404"), true);
  assert.equal(matchesSelectionPattern("4\\d\\d", "404x"), false);
  assert.equal(matchesSelectionPattern("5\\d\\d", "404"), false);

  // HTTP integrations match against the backend status code string.
  assert.equal(selectIntegrationResponse(RESPONSES, { backendStatus: 200 })?.statusCode, "200");
  assert.equal(selectIntegrationResponse(RESPONSES, { backendStatus: 404 })?.statusCode, "400");
  assert.equal(selectIntegrationResponse(RESPONSES, { backendStatus: 503 })?.statusCode, "500");

  // FUNCTION/AWS integrations match against the function errorMessage.
  const functionResponses = [
    { statusCode: "200", selectionPattern: "" },
    { statusCode: "502", selectionPattern: ".*Task timed out.*" },
  ];
  assert.equal(
    selectIntegrationResponse(functionResponses, { errorMessage: "Task timed out after 3.0 seconds", integrationType: "FUNCTION" })?.statusCode,
    "502",
  );
  assert.equal(
    selectIntegrationResponse(functionResponses, { backendStatus: 200, integrationType: "FUNCTION" })?.statusCode,
    "200",
    "no error → default response",
  );

  // Nothing matches and no default → null (caller raises 500 API_CONFIGURATION_ERROR).
  assert.equal(selectIntegrationResponse([{ statusCode: "400", selectionPattern: "4\\d\\d" }], { backendStatus: 500 }), null);

  // MOCK selects by the rendered request template statusCode.
  assert.equal(selectMockStatus('{"statusCode": 200}'), "200");
  assert.equal(selectMockStatus("not json"), null);
  const mockResponses = [{ statusCode: "200", selectionPattern: "" }, { statusCode: "400", selectionPattern: "" }];
  assert.equal(selectIntegrationResponse(mockResponses, { mockStatusCode: 400 })?.statusCode, "400");

  // Overrides from a response template win last.
  const overridden = applyResponseOverrides(
    { statusCode: 200, headers: { "X-Keep": "a" } },
    { responseOverride: { status: 201, header: { "X-Extra": "b" } } },
  );
  assert.equal(overridden.statusCode, 201);
  assert.deepEqual(overridden.headers, { "X-Keep": "a", "X-Extra": "b" });
  const requested = applyRequestOverrides(
    { headers: {}, querystring: {}, path: {} },
    { requestOverride: { header: { "X-H": "1" }, querystring: { q: "2" }, path: { id: "3" } } },
  );
  assert.deepEqual(requested, { headers: { "X-H": "1" }, querystring: { q: "2" }, path: { id: "3" } });

  // Compile: an integration-response status without a method_responses row fails.
  const { errors } = validateProcessing({
    methods: [{
      methodId: "m1",
      integrationResponses: [{ statusCode: "500", selectionPattern: "5\\d\\d" }],
      methodResponses: [{ statusCode: "200", responseParameters: {}, responseModels: {} }],
    }],
  });
  assert.ok(errors.some((entry) => entry.code === "undeclared_method_response"), JSON.stringify(errors));
  // Declared → clean.
  const clean = validateProcessing({
    methods: [{
      methodId: "m1",
      integrationResponses: [
        { statusCode: "200", selectionPattern: "" },
        { statusCode: "500", selectionPattern: "5\\d\\d" },
      ],
      methodResponses: [
        { statusCode: "200", responseParameters: {}, responseModels: {} },
        { statusCode: "500", responseParameters: {}, responseModels: {} },
      ],
    }],
  });
  assert.deepEqual(clean.errors, []);
});
