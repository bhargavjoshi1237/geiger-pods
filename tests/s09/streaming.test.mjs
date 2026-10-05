/**
 * S09 streaming acceptance tests: compile conflicts (bullet 14) and Lambda
 * prelude parsing (bullet 15). Runtime streaming bullets live in
 * `runtime.test.mjs` / `streaming-limits.test.mjs`.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { compile } from "../../lib/gateway/artifact/compile.mjs";
import {
  ByteLimiter,
  parseLambdaStreamPrelude,
  validateStreamingConfig,
} from "../../lib/gateway/core/release/streaming.mjs";

function streamDraft(overrides = {}) {
  return {
    projectId: "proj-s09",
    apiId: "api-s09",
    apiPublicId: "s09stream001",
    protocol: "REST",
    resources: [{ id: "res-root", path: "/" }, { id: "res-pets", path: "/pets" }],
    methods: [{
      id: "m1", resourceId: "res-pets", httpMethod: "GET",
      authorizationType: "NONE", authorizerId: null, authorizationScopes: [],
      apiKeyRequired: false, requestValidatorId: null, requestParameters: {},
      requestModels: {}, integrationId: "int-1",
    }],
    integrations: [{
      id: "int-1", type: "HTTP_PROXY", uri: "https://backend.test/echo", timeoutMs: 5000,
      responseTransferMode: "STREAM",
      ...overrides,
    }],
  };
}

test("S09: STREAM with cache enabled / VTL response template → compile error", () => {
  // Valid STREAM compiles clean.
  const ok = compile(streamDraft());
  assert.equal(ok.errors.length, 0, `valid STREAM must compile: ${ok.errors[0]?.message}`);

  // STREAM + cache key params → conflict named.
  const cached = compile(streamDraft({ cacheKeyParameters: ["method.request.querystring.page"] }));
  assert.ok(
    cached.errors.some((entry) => /STREAM is incompatible with stage caching/.test(entry.message)),
    `expected cache conflict, got: ${JSON.stringify(cached.errors)}`,
  );

  // STREAM + VTL response template → conflict named.
  const templated = compile({
    ...streamDraft(),
    integrationResponses: [{
      integrationId: "int-1", statusCode: "200",
      responseTemplates: { "application/json": "$input.body" },
    }],
    methodResponses: [{ methodId: "m1", statusCode: "200" }],
  });
  assert.ok(
    templated.errors.some((entry) => /STREAM is incompatible with response mapping templates/.test(entry.message)),
    `expected template conflict, got: ${JSON.stringify(templated.errors)}`,
  );

  // STREAM on a non-proxy type → rejected.
  const wrongType = compile(streamDraft({ type: "HTTP" }));
  assert.ok(
    wrongType.errors.some((entry) => /only supported for HTTP_PROXY and FUNCTION_PROXY/.test(entry.message)),
    `expected type error, got: ${JSON.stringify(wrongType.errors)}`,
  );

  // Pure helper parity.
  assert.deepEqual(
    validateStreamingConfig({ protocol: "REST", integrationType: "HTTP_PROXY", transferMode: "STREAM" }),
    [],
  );
  assert.ok(validateStreamingConfig({ protocol: "HTTP", integrationType: "HTTP_PROXY", transferMode: "STREAM" }).length > 0);
});

test("S09: Lambda streaming prelude + 8 NUL delimiter parsed into status/headers/body", () => {
  const prelude = JSON.stringify({ statusCode: 201, headers: { "content-type": "text/event-stream", "x-a": "b" }, cookies: ["session=1"] });
  const body = "data: hello\n\ndata: world\n\n";
  const framed = Buffer.concat([Buffer.from(prelude, "utf8"), Buffer.alloc(8, 0), Buffer.from(body, "utf8")]);
  const parsed = parseLambdaStreamPrelude(framed);
  assert.equal(parsed.statusCode, 201);
  assert.deepEqual(parsed.headers, { "content-type": "text/event-stream", "x-a": "b" });
  assert.deepEqual(parsed.cookies, ["session=1"]);
  assert.equal(Buffer.from(parsed.body).toString("utf8"), body);

  assert.throws(() => parseLambdaStreamPrelude(Buffer.from("no delimiter here")), /delimiter/);
});

test("S09: bandwidth limiter passes the first 10 MB then caps (injected clock)", () => {
  let now = 0;
  const clock = { now: () => now };
  const limiter = new ByteLimiter({ capBytesPerSec: 2 * 1024 * 1024, clock });
  assert.equal(limiter.take(5 * 1024 * 1024, now), 0);
  assert.equal(limiter.take(5 * 1024 * 1024, now), 0);
  // Past 10 MB: 1 more MB needs ~0.5 s at 2 MB/s (burst 2 MB covers part).
  now += 100;
  const wait = limiter.take(1024 * 1024, now);
  assert.ok(wait >= 0, "limiter must return a wait estimate");
});
