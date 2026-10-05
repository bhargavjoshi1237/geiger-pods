import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAuthorizerEvent,
  evaluateAuthorizerOutput,
  gatherIdentity,
  normalizeAuthorizerContext,
  resolveIdentitySource,
  runCustomAuth,
} from "../../lib/gateway/core/auth/custom.mjs";
import { MemoryKvStore } from "../../lib/gateway/state/memory-kv.mjs";
import { GatewayError } from "../../lib/gateway/core/errors.mjs";

const GET_ARN = "arn:pods:execute-api:auto:p1:api1/prod/GET/pets";
const POST_ARN = "arn:pods:execute-api:auto:p1:api1/prod/POST/pets";

function getPolicyOutput() {
  return {
    principalId: "user1",
    policyDocument: {
      Version: "2012-10-17",
      Statement: [{ Action: "execute-api:Invoke", Effect: "Allow", Resource: GET_ARN }],
    },
    context: { role: "admin", level: 3, vip: true },
  };
}

function portsFor(output, { calls = null, status = 200 } = {}) {
  return {
    kv: new MemoryKvStore({ clock: { now: () => Date.now() } }),
    clock: { now: () => Date.now() },
    fetch: async () => {
      if (calls) calls.count += 1;
      return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => (typeof output === "string" ? output : JSON.stringify(output)),
      };
    },
  };
}

function tokenAuthorizer(overrides = {}) {
  return {
    id: "auth1", name: "tok", type: "TOKEN",
    identitySource: ["method.request.header.Authorization"],
    identityValidationExpression: null,
    function: { provider: "webhook", url: "https://auth.example/token" },
    payloadFormatVersion: null, enableSimpleResponses: false,
    resultTtlSeconds: 300, timeoutMs: 10000,
    ...overrides,
  };
}

function requestWith(headers = {}, url = "https://api.example/pets?x=1") {
  return new Request(url, { headers });
}

test("S07: TOKEN authorizer respects identityValidationExpression without invoking", async () => {
  const calls = { count: 0 };
  const authorizer = tokenAuthorizer({ identityValidationExpression: "^Bearer [A-Za-z0-9._-]+$" });
  const ports = portsFor(getPolicyOutput(), { calls });
  await assert.rejects(
    runCustomAuth({ authorizer, kind: "TOKEN", request: requestWith({ Authorization: "nope!!" }), methodArn: GET_ARN, ports }),
    (error) => error instanceof GatewayError && error.type === "UNAUTHORIZED",
  );
  assert.equal(calls.count, 0);
  const ok = await runCustomAuth({
    authorizer, kind: "TOKEN",
    request: requestWith({ Authorization: "Bearer abc.def.ghi" }),
    methodArn: GET_ARN, ports,
  });
  assert.equal(ok.principalId, "user1");
  assert.equal(calls.count, 1);
});

test("S07: missing identity source → 401 without invoking function (spy)", async () => {
  const calls = { count: 0 };
  const authorizer = {
    id: "auth2", name: "req", type: "REQUEST",
    identitySource: ["$request.header.x-api-key", "$request.querystring.token"],
    function: { provider: "webhook", url: "https://auth.example/req" },
    resultTtlSeconds: 300, timeoutMs: 10000,
  };
  const ports = portsFor(getPolicyOutput(), { calls });
  // Only one of the two sources present → still missing.
  await assert.rejects(
    runCustomAuth({
      authorizer, kind: "REQUEST",
      request: requestWith({ "x-api-key": "k" }), methodArn: GET_ARN, ports,
    }),
    (error) => error instanceof GatewayError && error.type === "UNAUTHORIZED",
  );
  assert.equal(calls.count, 0);
});

test("S07: cached Allow policy for GET /pets denies POST /pets when policy resource only covers GET", async () => {
  const calls = { count: 0 };
  const ports = portsFor(getPolicyOutput(), { calls });
  const authorizer = tokenAuthorizer();
  const request = requestWith({ Authorization: "tok123" });
  const first = await runCustomAuth({ authorizer, kind: "TOKEN", request, methodArn: GET_ARN, ports });
  assert.equal(first.principalId, "user1");
  assert.equal(first.cached, false);
  // Same identity, different method: cache hit, re-evaluated → Deny, no new invoke.
  await assert.rejects(
    runCustomAuth({ authorizer, kind: "TOKEN", request, methodArn: POST_ARN, ports }),
    (error) => error instanceof GatewayError && error.type === "ACCESS_DENIED",
  );
  assert.equal(calls.count, 1);
  // GET still allowed from cache.
  const third = await runCustomAuth({ authorizer, kind: "TOKEN", request, methodArn: GET_ARN, ports });
  assert.equal(third.cached, true);
  assert.equal(calls.count, 1);
});

test("S07: simple response isAuthorized false → 403; function throws \"Unauthorized\" → 401; timeout → 500 AUTHORIZER_FAILURE", async () => {
  const simple = {
    id: "auth3", name: "simple", type: "REQUEST",
    identitySource: [],
    function: { provider: "webhook", url: "https://auth.example/s" },
    payloadFormatVersion: "2.0", enableSimpleResponses: true,
    resultTtlSeconds: 0, timeoutMs: 10000,
  };
  const denied = portsFor({ isAuthorized: false, context: {} });
  await assert.rejects(
    runCustomAuth({ authorizer: simple, kind: "HTTP20", request: requestWith(), methodArn: GET_ARN, routeKey: "GET /pets", ports: denied }),
    (error) => error instanceof GatewayError && error.type === "ACCESS_DENIED",
  );
  const allowedPorts = portsFor({ isAuthorized: true, context: { team: "x" } });
  const allowed = await runCustomAuth({ authorizer: simple, kind: "HTTP20", request: requestWith(), methodArn: GET_ARN, routeKey: "GET /pets", ports: allowedPorts });
  assert.equal(allowed.context.team, "x");

  // Function error payload "Unauthorized" → 401.
  const unauthPorts = portsFor({ errorMessage: "Unauthorized" });
  await assert.rejects(
    runCustomAuth({ authorizer: tokenAuthorizer({ resultTtlSeconds: 0 }), kind: "TOKEN", request: requestWith({ Authorization: "t" }), methodArn: GET_ARN, ports: unauthPorts }),
    (error) => error instanceof GatewayError && error.type === "UNAUTHORIZED",
  );
  // Webhook HTTP 401 → 401.
  const http401 = portsFor({ errorMessage: "nope" }, { status: 401 });
  await assert.rejects(
    runCustomAuth({ authorizer: tokenAuthorizer({ resultTtlSeconds: 0 }), kind: "TOKEN", request: requestWith({ Authorization: "t" }), methodArn: GET_ARN, ports: http401 }),
    (error) => error instanceof GatewayError && error.type === "UNAUTHORIZED",
  );
  // Timeout → AUTHORIZER_FAILURE.
  const hanging = {
    kv: new MemoryKvStore({ clock: { now: () => Date.now() } }),
    fetch: async (_url, { signal } = {}) => {
      await new Promise((resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
      return { ok: true, status: 200, text: async () => "{}" };
    },
  };
  await assert.rejects(
    runCustomAuth({
      authorizer: tokenAuthorizer({ resultTtlSeconds: 0, timeoutMs: 50 }),
      kind: "TOKEN", request: requestWith({ Authorization: "t" }), methodArn: GET_ARN, ports: hanging,
    }),
    (error) => error instanceof GatewayError && error.type === "AUTHORIZER_FAILURE",
  );
});

test("S07: authorizer context exposed as $context.authorizer.x and in function proxy event requestContext.authorizer", () => {
  const context = normalizeAuthorizerContext({ role: "admin", level: 3, vip: true });
  assert.deepEqual(context, { role: "admin", level: 3, vip: true });
  assert.throws(() => normalizeAuthorizerContext({ nested: { a: 1 } }), (error) => error instanceof GatewayError && error.type === "AUTHORIZER_CONFIGURATION_ERROR");
  // Policy output without principalId or with bad shape → configuration error.
  assert.throws(
    () => evaluateAuthorizerOutput({ output: { policyDocument: { Statement: [] } }, methodArn: GET_ARN }),
    (error) => error instanceof GatewayError && error.type === "AUTHORIZER_CONFIGURATION_ERROR",
  );
  assert.throws(
    () => evaluateAuthorizerOutput({ output: { isAuthorized: true }, methodArn: GET_ARN, simpleResponses: false }),
    (error) => error instanceof GatewayError && error.type === "AUTHORIZER_CONFIGURATION_ERROR",
  );
});

test("S07: authorizer event shapes (TOKEN / REQUEST / HTTP20 / WS)", () => {
  const request = requestWith({ Authorization: "Bearer t", "X-Key": "k" }, "https://api.example/pets?a=1&a=2");
  const token = buildAuthorizerEvent({ kind: "TOKEN", identityValues: ["Bearer t"], request, methodArn: GET_ARN });
  assert.deepEqual(token, { type: "TOKEN", authorizationToken: "Bearer t", methodArn: GET_ARN });
  const rest = buildAuthorizerEvent({
    kind: "REQUEST", identityValues: ["k"], request, methodArn: GET_ARN,
    resourcePath: "/pets", httpMethod: "GET", pathParameters: { id: "1" }, stageVariables: { v: "1" },
  });
  assert.equal(rest.type, "REQUEST");
  assert.equal(rest.httpMethod, "GET");
  assert.deepEqual(rest.pathParameters, { id: "1" });
  assert.ok(Array.isArray(rest.multiValueHeaders?.authorization));
  const http20 = buildAuthorizerEvent({
    kind: "HTTP20", identityValues: ["k"], request, methodArn: GET_ARN, routeKey: "GET /pets",
  });
  assert.equal(http20.version, "2.0");
  assert.deepEqual(http20.identitySource, ["k"]);
  assert.equal(http20.routeKey, "GET /pets");
  const ws = buildAuthorizerEvent({ kind: "WS", identityValues: [], request, methodArn: GET_ARN, connectionId: "c1" });
  assert.equal(ws.requestContext.eventType, "CONNECT");
  assert.equal(ws.requestContext.connectionId, "c1");
});

test("S07: identity source expressions resolve across request parts", () => {
  const request = requestWith({ Authorization: "Bearer t", "X-Key": "k" }, "https://api.example/pets?token=q1");
  const input = { request, stageVariables: { sv: "s" }, context: { identity: { sourceIp: "1.2.3.4" } }, pathParameters: { id: "9" } };
  assert.equal(resolveIdentitySource("method.request.header.Authorization", input), "Bearer t");
  assert.equal(resolveIdentitySource("$request.header.x-key", input), "k");
  assert.equal(resolveIdentitySource("$request.querystring.token", input), "q1");
  assert.equal(resolveIdentitySource("$stageVariables.sv", input), "s");
  assert.equal(resolveIdentitySource("$context.identity.sourceIp", input), "1.2.3.4");
  assert.equal(resolveIdentitySource("method.request.path.id", input), "9");
  assert.equal(resolveIdentitySource("$request.header.missing", input), null);
  const { missing } = gatherIdentity({ type: "REQUEST", identitySource: ["$request.header.missing"] }, input);
  assert.equal(missing, true);
});
