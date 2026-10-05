import assert from "node:assert/strict";
import test from "node:test";
import { GatewayError } from "../../lib/gateway/core/errors.mjs";
import { buildContext } from "../../lib/gateway/core/context.mjs";
import {
  buildHttpEvent,
  buildRestEvent,
  parseProxyResponse20,
  selectCustomResponse,
  signWebhookBody,
  verifyWebhookSignature,
} from "../../lib/gateway/core/integrations/function.mjs";
import { invoke, invokeAws } from "../../lib/gateway/core/integrations/index.mjs";
import { invokeMock } from "../../lib/gateway/core/integrations/mock.mjs";
import { startUpstream } from "../fixtures/upstream.mjs";

process.env.PODS_ALLOW_LOOPBACK = "1";

const EPOCH = Date.UTC(2026, 9, 5, 12, 0, 0);

function makeCtx({ protocol = "REST", method = "POST", path = "/prod/pets/42", headers = {}, cookies = null } = {}) {
  const all = { "content-type": "application/json", "x-multi": "a", ...headers };
  const request = new Request(`https://gw.test${path}?type=dog&type=cat`, { method, headers: all });
  const artifact = { protocol, apiId: "abc123def4", stage: "prod", projectId: "proj-1", deploymentId: "dep-1" };
  const ctx = buildContext(request, artifact, {});
  ctx.context.requestTimeEpoch = EPOCH;
  ctx.context.resourcePath = "/pets/{id}";
  ctx.context.resourceId = "res123";
  ctx.context.routeKey = "POST /pets/{id}";
  ctx.routeKey = "POST /pets/{id}";
  ctx.resourcePath = "/pets/{id}";
  ctx.pathParams = { id: "42" };
  ctx.stageVariables = { ver: "v1" };
  ctx.signal = new AbortController().signal;
  if (cookies) {
    const rebuilt = new Request(`https://gw.test${path}`, {
      method,
      headers: { ...all, cookie: cookies },
    });
    ctx.request = rebuilt;
  }
  return ctx;
}

test("S04: payload 2.0 event matches AWS reference shape (snapshot) and 1.0 event matches REST reference shape", () => {
  const ctx = makeCtx({ protocol: "HTTP" });
  const event20 = buildHttpEvent(ctx, { version: "2.0", body: "{\"adopt\":true}", isBase64Encoded: false });
  assert.equal(event20.version, "2.0");
  assert.equal(event20.routeKey, "POST /pets/{id}");
  assert.equal(event20.rawPath, "/prod/pets/42");
  assert.equal(event20.rawQueryString, "type=dog&type=cat");
  assert.deepEqual(event20.cookies, []);
  assert.equal(event20.headers["content-type"], "application/json");
  assert.equal(event20.queryStringParameters.type, "dog,cat");
  assert.deepEqual(event20.pathParameters, { id: "42" });
  assert.deepEqual(event20.stageVariables, { ver: "v1" });
  assert.equal(event20.requestContext.http.method, "POST");
  assert.equal(event20.requestContext.http.path, "/prod/pets/42");
  assert.equal(event20.requestContext.http.protocol, "HTTP/1.1");
  assert.equal(event20.requestContext.stage, "prod");
  assert.equal(event20.requestContext.apiId, "abc123def4");
  assert.equal(event20.requestContext.timeEpoch, EPOCH);
  // Payload 2.0 `time` is CLF, the same string as `$context.requestTime` (AWS parity).
  assert.equal(event20.requestContext.time, ctx.context.requestTime);
  assert.match(event20.requestContext.time, /^\d{2}\/[A-Za-z]{3}\/\d{4}:\d{2}:\d{2}:\d{2} \+0000$/);
  assert.equal(event20.body, "{\"adopt\":true}");
  assert.equal(event20.isBase64Encoded, false);

  const rest = makeCtx({ protocol: "REST" });
  const event10 = buildRestEvent(rest, { body: "{\"adopt\":true}", isBase64Encoded: false });
  assert.equal(event10.resource, "/pets/{id}");
  assert.equal(event10.path, "/prod/pets/42");
  assert.equal(event10.httpMethod, "POST");
  assert.equal(event10.headers["content-type"], "application/json");
  assert.deepEqual(event10.multiValueHeaders["x-multi"], ["a"]);
  assert.deepEqual(event10.queryStringParameters, { type: "dog" });
  assert.deepEqual(event10.multiValueQueryStringParameters.type, ["dog", "cat"]);
  assert.deepEqual(event10.pathParameters, { id: "42" });
  assert.deepEqual(event10.stageVariables, { ver: "v1" });
  assert.equal(event10.requestContext.resourceId, "res123");
  assert.equal(event10.requestContext.apiId, "abc123def4");
  assert.equal(event10.body, "{\"adopt\":true}");
  assert.equal(event10.isBase64Encoded, false);
});

test("S04: 2.0 response inference: string → 200 json body; object without statusCode → 200 JSON; cookies → set-cookie headers", () => {
  const fromObject = parseProxyResponse20(JSON.stringify({ hello: "world" }));
  assert.equal(fromObject.status, 200);
  assert.equal(fromObject.headers.get("content-type"), "application/json");
  assert.equal(JSON.parse(Buffer.from(fromObject.body).toString("utf8")).hello, "world");

  const fromString = parseProxyResponse20(JSON.stringify("just a string"));
  assert.equal(fromString.status, 200);
  assert.equal(Buffer.from(fromString.body).toString("utf8"), "just a string");

  const withCookies = parseProxyResponse20({ cookies: ["a=1", "b=2"], hello: "world" });
  assert.equal(withCookies.status, 200);
  assert.deepEqual(withCookies.headers.getSetCookie(), ["a=1", "b=2"]);

  const explicit = parseProxyResponse20(JSON.stringify({ statusCode: 201, body: "created" }));
  assert.equal(explicit.status, 201);
  assert.equal(Buffer.from(explicit.body).toString("utf8"), "created");
});

test("S04: malformed function response → REST 502 / HTTP 500", async () => {
  const upstream = await startUpstream();
  try {
    const fn = { provider: "webhook", url: `${upstream.url}/fn?behavior=malformed` };
    const restCtx = makeCtx({ protocol: "REST" });
    await assert.rejects(
      invoke(restCtx, { type: "FUNCTION_PROXY", function: fn, payload_format_version: "1.0" }, {}, { fetch: globalThis.fetch }),
      (error) => error instanceof GatewayError && error.type === "DEFAULT_5XX" && error.statusCode === 502,
    );
    const httpCtx = makeCtx({ protocol: "HTTP" });
    // Payload 2.0 infers a body from any string output, so the HTTP 500 path
    // is exercised with a backend-side function error (non-2xx webhook).
    const errFn = { provider: "webhook", url: `${upstream.url}/fn?behavior=error-status` };
    await assert.rejects(
      invoke(httpCtx, { type: "FUNCTION_PROXY", function: errFn, payload_format_version: "2.0" }, {}, { fetch: globalThis.fetch }),
      (error) => error instanceof GatewayError && error.statusCode === 500,
    );
  } finally {
    await upstream.close();
  }
});

test("S04: webhook function requests carry a valid x-pods-signature", async () => {
  const upstream = await startUpstream();
  try {
    const ports = {
      fetch: globalThis.fetch,
      secrets: { async resolve(ref) { assert.equal(ref, "secret:wh1"); return { kind: "generic", value: { value: "topsecret" } }; } },
    };
    const ctx = makeCtx({ protocol: "HTTP" });
    const result = await invoke(ctx,
      { type: "FUNCTION_PROXY", function: { provider: "webhook", url: `${upstream.url}/fn`, secretRef: "secret:wh1" }, payload_format_version: "1.0" },
      {}, ports, { nowSec: 1760000000 });
    assert.equal(result.status, 200);
    const call = upstream.requests.find((entry) => entry.path === "/fn");
    const signature = call.headers["x-pods-signature"];
    assert.match(signature, /^t=\d+,v1=[0-9a-f]{64}$/);
    const expected = signWebhookBody("topsecret", call.body.toString("utf8"), 1760000000);
    assert.equal(signature, expected);
    assert.equal(verifyWebhookSignature("topsecret", call.body.toString("utf8"), signature, 1760000000 + 60), true);
    assert.equal(verifyWebhookSignature("wrong", call.body.toString("utf8"), signature, 1760000000 + 60), false);
  } finally {
    await upstream.close();
  }
});

test("S04: FUNCTION custom error selects integration response by errorMessage regex", async () => {
  const upstream = await startUpstream();
  try {
    const ctx = makeCtx({ protocol: "REST" });
    const result = await invoke(ctx, {
      type: "FUNCTION",
      function: { provider: "webhook", url: `${upstream.url}/fn?behavior=error-status` },
      integration_responses: [
        { status_code: 404, selection_pattern: "bo+m" },
        { status_code: 200, selection_pattern: null },
      ],
    }, {}, { fetch: globalThis.fetch });
    assert.equal(result.status, 404);
  } finally {
    await upstream.close();
  }

  assert.deepEqual(selectCustomResponse({ errorMessage: "Task timed out after 3.00 seconds" }, [
    { status_code: 503, selection_pattern: "timed out" },
    { status_code: 200, selection_pattern: null },
  ]).status_code, 503);
  assert.deepEqual(selectCustomResponse({ errorMessage: "other" }, [
    { status_code: 503, selection_pattern: "timed out" },
    { status_code: 200, selection_pattern: null },
  ]).status_code, 200);
  assert.equal(selectCustomResponse({ errorMessage: "other" }, [
    { status_code: 503, selection_pattern: "timed out" },
  ]), null);
});

test("S04: MOCK returns statusCode from rendered template", async () => {
  const templated = await invokeMock({}, {}, { renderedTemplate: JSON.stringify({ statusCode: 418, body: "teapot" }) });
  assert.equal(templated.status, 418);
  assert.deepEqual(templated.mockPayload, { statusCode: 418, body: "teapot" });
  const bare = await invokeMock({}, {}, {});
  assert.equal(bare.status, 200);
  assert.equal(bare.body.byteLength, 0);
});

test("S04: aws_lambda provider signs the Invoke call (shape)", async () => {
  let seen = null;
  const ports = {
    fetch: async (url, init) => {
      seen = { url, authorization: init.headers.authorization, invocationType: init.headers["x-amz-invocation-type"] };
      return new Response(JSON.stringify({ statusCode: 200, body: "{}" }), { status: 200, headers: { "content-type": "application/json" } });
    },
    secrets: {
      async resolve() {
        return { kind: "aws_credentials", value: { accessKeyId: "AKID", secretAccessKey: "SECRET", region: "us-east-1" } };
      },
    },
  };
  const ctx = makeCtx({ protocol: "REST" });
  const result = await invoke(ctx, {
    type: "FUNCTION_PROXY",
    function: { provider: "aws_lambda", functionArn: "arn:aws:lambda:us-east-1:123456789012:function:pods-fn", credentialsRef: "secret:creds" },
    payload_format_version: "1.0",
  }, {}, ports);
  assert.equal(result.status, 200);
  assert.match(seen.url, /^https:\/\/lambda\.us-east-1\.amazonaws\.com\//);
  assert.match(seen.authorization, /^AWS4-HMAC-SHA256 Credential=AKID\//);
  assert.equal(seen.invocationType, "RequestResponse");
  // A function-side error surfaces as a mapped proxy failure.
  const failing = {
    fetch: async () => new Response("{}", { status: 200, headers: { "x-amz-function-error": "Unhandled" } }),
    secrets: ports.secrets,
  };
  const ctx2 = makeCtx({ protocol: "REST" });
  await assert.rejects(
    invoke(ctx2, {
      type: "FUNCTION_PROXY",
      function: { provider: "aws_lambda", functionArn: "arn:aws:lambda:us-east-1:123456789012:function:pods-fn", credentialsRef: "secret:creds" },
    }, {}, failing),
    (error) => error instanceof GatewayError && error.statusCode === 502,
  );
});
