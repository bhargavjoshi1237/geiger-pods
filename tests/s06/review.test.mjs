import assert from "node:assert/strict";
import test from "node:test";

import { applyHttpRequestMapping, applyRestRequestMapping, resolveHttpSource, validateHttpMapping } from "../../lib/gateway/core/processing/param-mapping.mjs";
import { handlePreflight } from "../../lib/gateway/core/processing/cors.mjs";
import { convertResponseBody } from "../../lib/gateway/core/processing/content.mjs";
import { validateProcessing } from "../../lib/gateway/core/processing/validate-processing.mjs";
import { renderTemplate, buildInput, buildUtil } from "../../lib/gateway/core/processing/templates/index.mjs";
import { TemplateLimitError } from "../../lib/gateway/core/processing/templates/interpreter.mjs";

test("S06 review: HTTP header mapping is case-insensitive (no duplicate headers)", () => {
  const out = applyHttpRequestMapping(
    { headers: { "X-Foo": "bar" }, query: {}, path: "/" },
    { "overwrite:header.x-foo": "new" },
    { request: {} },
  );
  assert.equal(out.headers["x-foo"], "new");
  assert.equal(out.headers["X-Foo"], undefined, "old casing must not remain");
});

test("S06 review: HTTP mapping rejects recursive descent in braced and nested forms", () => {
  const braced = validateHttpMapping({ "overwrite:header.x-a": "${request.body..name}" }, "request");
  assert.ok(braced.errors.some((m) => m.includes("..") || m.includes("Recursive") || m.includes("recursive")), `braced .. should error, got ${JSON.stringify(braced)}`);
  const nested = validateHttpMapping({ "overwrite:header.x-a": "$request.body.a..b" }, "request");
  assert.ok(nested.errors.length > 0, `nested .. should error, got ${JSON.stringify(nested)}`);
});

test("S06 review: binary media types accept */*", () => {
  const { errors } = validateProcessing({ binaryMediaTypes: ["*/*"] });
  assert.deepEqual(errors, [], `*/* must validate, got ${JSON.stringify(errors)}`);
});

test("S06 review: response binary-ness follows Accept, not Content-Type", () => {
  const r = convertResponseBody({
    body: "hello",
    contentType: "image/png",
    acceptHeader: "application/json",
    binaryMediaTypes: ["image/png"],
  });
  assert.equal(r.isBinary, false, "Accept application/json does not match image/png, must not be binary");
});

test("S06 review: preflight returns configured methods only (no echo of unlisted method)", () => {
  const req = new Request("https://gw.test/items", {
    method: "OPTIONS",
    headers: { origin: "https://example.com", "access-control-request-method": "DELETE" },
  });
  const cors = {
    allowOrigins: ["https://example.com"],
    allowMethods: ["GET"],
    allowHeaders: [],
    exposeHeaders: [],
    maxAge: 600,
    allowCredentials: false,
  };
  const resp = handlePreflight(req, cors);
  const methods = resp.headers.get("access-control-allow-methods") ?? "";
  assert.ok(methods.includes("GET"), `should include GET, got ${methods}`);
  assert.ok(!methods.includes("DELETE"), `must not echo unlisted DELETE, got ${methods}`);
});

test("S06 review: range expression is bounded (no unbounded array alloc)", () => {
  assert.throws(() => renderTemplate("#set($x = [1..5000000])$x.size()", {}), (e) => e instanceof TemplateLimitError);
});

test("S06 review: escapeJavaScript escapes backspace", () => {
  const util = buildUtil();
  const bs = String.fromCharCode(8);
  assert.equal(util.escapeJavaScript("a" + bs + "b"), "a\\bb");
});

test("S06 review: undeclared method-response header fails compile", () => {
  const { errors } = validateProcessing({
    methods: [{
      methodId: "m1",
      integrationResponses: [{
        statusCode: "200",
        selectionPattern: "",
        responseParameters: { "method.response.header.X-New": "integration.response.header.X-Up" },
        responseTemplates: {},
      }],
      methodResponses: [{ statusCode: "200", responseParameters: {}, responseModels: {} }],
    }],
  });
  assert.ok(errors.some((e) => e.code === "invalid_mapping" && JSON.stringify(e).includes("X-New")), `expected undeclared header error, got ${JSON.stringify(errors)}`);
});

test("S06 review: prototype names do not leak via mapping or input params", () => {
  assert.equal(resolveHttpSource("context.toString", { request: {}, context: {}, stageVariables: {} }), "");
  assert.equal(resolveHttpSource("context.hasOwnProperty", { request: {}, context: {}, stageVariables: {} }), "");
  assert.equal(buildInput({ headers: {}, querystring: {}, pathParams: {} }).params("constructor"), "");
  assert.equal(buildInput({ headers: {}, querystring: {}, pathParams: {} }).params("toString"), "");
  const r = applyRestRequestMapping(
    { "integration.request.header.X": "method.request.header.constructor" },
    { methodRequest: { headers: {}, querystring: {}, path: {} }, bodyText: "", context: {}, stageVariables: {} },
  );
  assert.equal(r.headers.X, "");
});
