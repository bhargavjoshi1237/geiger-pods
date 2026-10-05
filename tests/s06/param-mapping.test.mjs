import assert from "node:assert/strict";
import test from "node:test";

import {
  applyHttpRequestMapping,
  applyHttpResponseMapping,
  applyRestRequestMapping,
  applyRestResponseMapping,
  defaultPathMappings,
  interpolateValue,
  isReservedHeader,
  truncateBody,
  validateHttpMapping,
  validateRestRequestMapping,
  validateRestResponseMapping,
} from "../../lib/gateway/core/processing/param-mapping.mjs";
import { validateProcessing } from "../../lib/gateway/core/processing/validate-processing.mjs";

function requestData(overrides = {}) {
  return {
    request: {
      path: "/users/42",
      headers: { "x-name": "Ada", "x-multi": ["a", "b"] },
      query: { page: "2" },
      pathParams: { name: "users", id: "42" },
      bodyText: JSON.stringify({ a: { b: "deep" } }),
      path: "/users/42",
      ...overrides,
    },
    context: { stage: "prod" },
    stageVariables: { env: "prod" },
  };
}

test("S06: HTTP mapping append/overwrite/remove for header and querystring; overwrite:path; response overwrite:statuscode for 500→403", () => {
  const data = requestData();
  const mapped = applyHttpRequestMapping(
    { headers: { "x-name": "Ada", "x-drop": "gone" }, query: { page: "2", drop: "1" }, path: "/users/42" },
    {
      "remove:header.x-drop": "",
      "overwrite:header.x-name": "$request.header.x-name",
      "append:header.x-multi": "c",
      "remove:querystring.drop": "",
      "overwrite:querystring.page": "$request.querystring.page",
      "append:querystring.tag": "$stageVariables.env",
      "overwrite:path": "$request.path",
    },
    data,
  );
  assert.equal(mapped.headers["x-drop"], undefined);
  assert.equal(mapped.headers["x-name"], "Ada");
  assert.equal(mapped.query.drop, undefined);
  assert.equal(mapped.query.page, "2");
  assert.equal(mapped.query.tag, "prod");
  assert.equal(mapped.path, "/users/42");

  // Append joins multi-valued sources with commas.
  const appended = applyHttpRequestMapping(
    { headers: { "x-multi": "a,b" }, query: {}, path: "/" },
    { "append:header.x-multi": "$request.header.x-multi" },
    requestData(),
  );
  assert.equal(appended.headers["x-multi"], "a,b,a,b");

  // Response mapping: backend 500 becomes 403 with a mapped header.
  const response = applyHttpResponseMapping(
    { statusCode: 500, headers: { "x-debug": "1" } },
    { 500: { "overwrite:statuscode": "403", "overwrite:header.x-reason": "$response.header.x-debug" } },
    { ...data, response: { headers: { "x-debug": "1" }, bodyText: "" } },
  );
  assert.equal(response.statusCode, 403);
  assert.equal(response.headers["x-reason"], "1");

  // REST request mapping from method.request sources, statics and context.
  const rest = applyRestRequestMapping(
    {
      "integration.request.header.X-Target": "method.request.header.X-Name",
      "integration.request.querystring.page": "method.request.querystring.page",
      "integration.request.path.id": "method.request.path.id",
      "integration.request.header.X-Static": "'fixed'",
      "integration.request.header.X-Stage": "stageVariables.env",
      "integration.request.header.X-Body": "method.request.body.a.b",
    },
    {
      methodRequest: { headers: { "X-Name": "Ada" }, querystring: { page: "2" }, path: { id: "42" } },
      bodyText: JSON.stringify({ a: { b: "deep" } }),
      stageVariables: { env: "prod" },
      context: {},
    },
  );
  assert.equal(rest.headers["X-Target"], "Ada");
  assert.equal(rest.querystring.page, "2");
  assert.equal(rest.path.id, "42");
  assert.equal(rest.headers["X-Static"], "fixed");
  assert.equal(rest.headers["X-Stage"], "prod");
  assert.equal(rest.headers["X-Body"], "deep");

  // REST response mapping from integration response sources.
  const restResponse = applyRestResponseMapping(
    { "method.response.header.X-Reply": "integration.response.header.X-Upstream" },
    { integrationResponse: { headers: { "x-upstream": "yes" } }, bodyText: "" },
  );
  assert.equal(restResponse["X-Reply"], "yes");

  // Unmapped {id} path params default to method.request.path.id.
  assert.deepEqual(defaultPathMappings("https://svc/users/{id}", {}), {
    "integration.request.path.id": "method.request.path.id",
  });
  assert.deepEqual(defaultPathMappings("https://svc/users/{id}", { "integration.request.path.id": "'7'" }), {});
});

test("S06: reserved header mapping rejected at compile", () => {
  for (const name of ["authorization", "Content-Length", "X-Amzn-Trace-Id", "X-Pods-Internal", "Origin", "x-forwarded-for"]) {
    assert.equal(isReservedHeader(name), true, `${name} should be reserved`);
  }
  assert.equal(isReservedHeader("x-custom"), false);
  const { errors } = validateHttpMapping({ "overwrite:header.authorization": "$context.stage" }, "request");
  assert.ok(errors.some((message) => message.includes("reserved")), `expected reserved error, got ${errors}`);
  const badKey = validateHttpMapping({ "overwrite:header": "x" }, "request");
  assert.ok(badKey.errors.length > 0);
  const rest = validateRestRequestMapping({ "integration.request.header.Authorization": "method.request.header.X" });
  assert.ok(rest.errors.some((message) => message.includes("reserved")));
  // Through the deploy-time entry S05 calls:
  const compiled = validateProcessing({
    httpMappings: { request: { "append:header.connection": "keep-alive" }, responses: {} },
  });
  assert.ok(compiled.errors.some((entry) => entry.message.includes("reserved")), JSON.stringify(compiled.errors));
});

test("S06: ${request.path.name} ${request.path.id} interpolation; $request.body.a.b truncation at 100 KB", () => {
  const data = requestData();
  assert.equal(interpolateValue("${request.path.name} ${request.path.id}", data), "users 42");
  assert.equal(interpolateValue("$request.body.a.b", data), "deep");
  assert.equal(interpolateValue("static", data), "static");
  assert.equal(interpolateValue("$context.stage", data), "prod");

  // Bodies are truncated to 100 KB before mapping evaluation.
  const padding = "x".repeat(110 * 1024);
  const big = JSON.stringify({ a: { b: "visible-near-start" }, tail: padding });
  assert.ok(Buffer.byteLength(big, "utf8") > 100 * 1024);
  const truncated = truncateBody(big);
  assert.ok(Buffer.byteLength(truncated, "utf8") <= 100 * 1024);
  // The truncated prefix no longer parses (cut mid-string), so body paths
  // resolve to "" instead of reading unbounded input.
  assert.equal(interpolateValue("$request.body.a.b", { request: { bodyText: big } }), "");
  // Small bodies evaluate normally, including multi-value joins.
  assert.equal(interpolateValue("$request.header.x-multi", data), "a,b");
  const unknown = validateHttpMapping({ "overwrite:header.x-a": "$request.unknown.thing" }, "request");
  assert.ok(unknown.warnings.length > 0);
  // REST response mappings must target declared method-response headers.
  const undeclared = validateRestResponseMapping(
    { "method.response.header.X-New": "integration.response.header.X-Up" },
    { "method.response.header.X-Old": true },
  );
  assert.ok(undeclared.errors.some((message) => message.includes("not declared")));
});
