import assert from "node:assert/strict";
import test from "node:test";

import {
  compileModelSchemas,
  findMissingParameters,
  formatValidationErrorString,
  selectModelForContentType,
  validateRequest,
} from "../../lib/gateway/core/processing/validation.mjs";
import { GatewayError } from "../../lib/gateway/core/errors.mjs";

const ORDER_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string" },
    age: { type: "integer", minimum: 0 },
  },
  required: ["name"],
  additionalProperties: false,
};

function validatorsFor() {
  const { validators, errors } = compileModelSchemas([{ name: "Order", schema: ORDER_SCHEMA }], { apiPublicId: "testapi1234" });
  assert.deepEqual(errors, []);
  return validators;
}

test("S06: required query param missing → 400 BAD_REQUEST_PARAMETERS \"Missing required request parameters: [page]\"", () => {
  assert.deepEqual(
    findMissingParameters(
      { "method.request.querystring.page": true, "method.request.header.X-Opt": false },
      { querystring: {}, headers: {}, path: {} },
    ),
    ["page"],
  );
  assert.deepEqual(
    findMissingParameters({ "method.request.querystring.page": true }, { querystring: { page: " " }, headers: {}, path: {} }),
    ["page"],
    "blank values count as missing",
  );
  try {
    validateRequest({
      requiredParams: { "method.request.querystring.page": true },
      actualParams: { querystring: {}, headers: {}, path: {} },
    });
    assert.fail("expected GatewayError");
  } catch (error) {
    assert.ok(error instanceof GatewayError);
    assert.equal(error.type, "BAD_REQUEST_PARAMETERS");
    assert.equal(error.statusCode, 400);
    assert.equal(error.message, "Missing required request parameters: [page]");
  }
  // Present params pass straight through to body validation.
  const ok = validateRequest({
    requiredParams: { "method.request.querystring.page": true },
    actualParams: { querystring: { page: "2" }, headers: {}, path: {} },
    requestModels: {},
    validators: new Map(),
  });
  assert.equal(ok.modelName, null);
});

test("S06: body failing draft-04 schema → 400 Invalid request body; validationErrorString AWS-style; $default model fallback", () => {
  const validators = validatorsFor();
  // Model selection: exact content type wins, params stripped, $default fallback.
  assert.equal(selectModelForContentType({ "application/json": "Order" }, "application/json; charset=utf-8"), "Order");
  assert.equal(selectModelForContentType({ $default: "Order" }, "application/xml"), "Order");
  assert.equal(selectModelForContentType({}, "application/json"), null);
  // Draft-04 semantics: additionalProperties is enforced (removed in 2020-12
  // strict mode only if misconfigured — here it must still reject).
  try {
    validateRequest({
      requestModels: { "application/json": "Order" },
      contentType: "application/json",
      bodyText: JSON.stringify({ age: 3, extra: true }),
      validators,
    });
    assert.fail("expected GatewayError");
  } catch (error) {
    assert.ok(error instanceof GatewayError);
    assert.equal(error.type, "BAD_REQUEST_BODY");
    assert.equal(error.statusCode, 400);
    assert.equal(error.message, "Invalid request body");
    assert.match(error.extra.validationErrorString, /missing required properties/);
    assert.match(error.extra.validationErrorString, /\["name"\]/);
  }
  // Invalid JSON is a body error, not a schema error.
  try {
    validateRequest({
      requestModels: { "application/json": "Order" },
      contentType: "application/json",
      bodyText: "{nope",
      validators,
    });
    assert.fail("expected GatewayError");
  } catch (error) {
    assert.ok(error instanceof GatewayError);
    assert.equal(error.type, "BAD_REQUEST_BODY");
  }
  // Valid bodies pass and report the model used.
  const ok = validateRequest({
    requestModels: { $default: "Order" },
    contentType: "application/vnd.api+json",
    bodyText: JSON.stringify({ name: "Ada", age: 36 }),
    validators,
  });
  assert.equal(ok.modelName, "Order");
  // Non-JSON content types are not schema-validated.
  const skipped = validateRequest({
    requestModels: { "application/xml": "Order" },
    contentType: "application/xml",
    bodyText: "<order/>",
    validators,
  });
  assert.equal(skipped.modelName, "Order");
  // AWS-style error string unit check.
  assert.equal(formatValidationErrorString([]), "[object has invalid value]");
});
