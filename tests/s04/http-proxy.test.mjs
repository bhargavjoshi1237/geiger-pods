import assert from "node:assert/strict";
import test from "node:test";
import { GatewayError } from "../../lib/gateway/core/errors.mjs";
import { buildContext } from "../../lib/gateway/core/context.mjs";
import { invoke, mapInvocationError } from "../../lib/gateway/core/integrations/index.mjs";
import { invokeHttp } from "../../lib/gateway/core/integrations/http.mjs";
import { startUpstream } from "../fixtures/upstream.mjs";

process.env.PODS_ALLOW_LOOPBACK = "1";

function makeCtx({ protocol = "REST", method = "GET", path = "/items", headers = {}, stage = "prod" } = {}) {
  const request = new Request(`https://gw.test/${stage}${path}`, { method, headers });
  const artifact = { protocol, apiId: "abc123def4", stage, projectId: "proj-1" };
  const ctx = buildContext(request, artifact, {});
  ctx.signal = new AbortController().signal;
  ctx.pathParams = {};
  ctx.greedyParams = [];
  ctx.stageVariables = {};
  return ctx;
}

const ports = { log() {} };

test("S04: HTTP_PROXY forwards method/path/query/body/headers; strips hop-by-hop and x-pods-*; sets X-Forwarded-For", async () => {
  const upstream = await startUpstream();
  try {
    const ctx = makeCtx({ method: "POST", path: "/items" });
    ctx.context.identity.sourceIp = "203.0.113.7";
    const result = await invokeHttp(ctx, { type: "HTTP_PROXY", timeout_ms: 5000 }, {
      method: "POST",
      url: `${upstream.url}/echo?tag=1`,
      headers: new Headers({
        "content-type": "application/json",
        "x-custom": "keep-me",
        "upgrade": "websocket-in-test",
        "proxy-authorization": "Basic c2VjcmV0",
        "transfer-encoding": "chunked",
        "x-pods-request-id": "spoofed",
      }),
      body: new TextEncoder().encode(JSON.stringify({ hello: 1 })),
    }, ports);
    assert.equal(result.status, 200);
    const seen = JSON.parse(Buffer.from(result.body).toString("utf8"));
    assert.equal(seen.method, "POST");
    assert.equal(seen.path, "/echo");
    assert.equal(seen.query, "?tag=1");
    assert.equal(seen.headers["x-custom"], "keep-me");
    assert.equal(seen.headers["upgrade"], undefined);
    assert.equal(seen.headers["proxy-authorization"], undefined);
    assert.equal(seen.headers["transfer-encoding"], undefined);
    assert.equal(seen.headers["x-pods-request-id"], undefined);
    assert.match(seen.headers["x-forwarded-for"] ?? "", /203\.0\.113\.7/);
    assert.equal(seen.headers.host, `127.0.0.1:${upstream.port}`);
    assert.equal(JSON.parse(seen.body).hello, 1);
    assert.ok(result.latencyMs >= 0);
  } finally {
    await upstream.close();
  }
});

test("S04: {proxy} greedy substitution preserves slashes; {id} is percent-encoded", async () => {
  const upstream = await startUpstream();
  try {
    const ctx = makeCtx({ path: "/files/a/b/c" });
    ctx.pathParams = { proxy: "a/b/c", id: "a/b c" };
    ctx.greedyParams = ["proxy"];
    const result = await invokeHttp(ctx, {
      type: "HTTP_PROXY",
      uri: `${upstream.url}/files/{proxy}`,
      timeout_ms: 5000,
    }, { method: "GET", url: null, headers: new Headers() }, ports);
    assert.equal(result.status, 200);
    const seen = JSON.parse(Buffer.from(result.body).toString("utf8"));
    assert.equal(seen.path, "/files/a/b/c");

    const ctx2 = makeCtx({ path: "/items/x" });
    ctx2.pathParams = { id: "a/b c" };
    const result2 = await invokeHttp(ctx2, {
      type: "HTTP_PROXY",
      uri: `${upstream.url}/items/{id}`,
      timeout_ms: 5000,
    }, { method: "GET", url: null, headers: new Headers() }, ports);
    const seen2 = JSON.parse(Buffer.from(result2.body).toString("utf8"));
    assert.equal(seen2.path, "/items/a%2Fb%20c");
  } finally {
    await upstream.close();
  }
});

test("S04: HTTP API $default route appends full path to integration URI", async () => {
  const upstream = await startUpstream();
  try {
    const ctx = makeCtx({ protocol: "HTTP", path: "/orders/42" });
    ctx.routeKey = "$default";
    const result = await invokeHttp(ctx, {
      type: "HTTP_PROXY",
      uri: `${upstream.url}/base`,
      timeout_ms: 5000,
    }, { method: "GET", url: null, headers: new Headers() }, ports);
    const seen = JSON.parse(Buffer.from(result.body).toString("utf8"));
    assert.equal(seen.path, "/base/orders/42");
  } finally {
    await upstream.close();
  }
});

test("S04: 3xx from backend is returned, not followed", async () => {
  const upstream = await startUpstream();
  try {
    const ctx = makeCtx({});
    const result = await invokeHttp(ctx, { type: "HTTP_PROXY", timeout_ms: 5000 }, {
      method: "GET",
      url: `${upstream.url}/redirect`,
      headers: new Headers(),
    }, ports);
    assert.equal(result.status, 302);
    assert.equal(result.headers.get("location"), "/final?followed=1");
    assert.equal(upstream.requests.filter((entry) => entry.path === "/final").length, 0);
  } finally {
    await upstream.close();
  }
});

test("S04: timeout → REST 504 INTEGRATION_TIMEOUT, HTTP 503; client abort cancels upstream request", async () => {
  const upstream = await startUpstream();
  try {
    const restCtx = makeCtx({ protocol: "REST" });
    await assert.rejects(
      invoke(restCtx, { type: "HTTP_PROXY", timeout_ms: 200 }, {
        method: "GET",
        url: `${upstream.url}/sleep/2000`,
        headers: new Headers(),
      }, ports),
      (error) => error instanceof GatewayError && error.type === "INTEGRATION_TIMEOUT" && error.statusCode === 504,
    );
    assert.equal(restCtx.context.integration.error, "INTEGRATION_TIMEOUT");

    const httpCtx = makeCtx({ protocol: "HTTP" });
    await assert.rejects(
      invoke(httpCtx, { type: "HTTP_PROXY", timeout_ms: 200 }, {
        method: "GET",
        url: `${upstream.url}/sleep/2000`,
        headers: new Headers(),
      }, ports),
      (error) => error instanceof GatewayError && error.type === "INTEGRATION_TIMEOUT" && error.statusCode === 503,
    );

    // Client abort cancels the upstream request.
    const controller = new AbortController();
    const abortCtx = makeCtx({});
    abortCtx.signal = controller.signal;
    const pending = invoke(abortCtx, { type: "HTTP_PROXY", timeout_ms: 10000 }, {
      method: "GET",
      url: `${upstream.url}/sleep/2000`,
      headers: new Headers(),
    }, ports);
    setTimeout(() => controller.abort(), 150);
    await assert.rejects(pending, (error) => error instanceof GatewayError);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const sleeps = upstream.requests.filter((entry) => entry.path === "/sleep/2000");
    assert.ok(sleeps.length >= 1);
    assert.ok(sleeps.some((entry) => entry.aborted), "expected the upstream to see the socket close");
  } finally {
    await upstream.close();
  }
});

test("S04: buffered upstream body > 10 MB → REST 502", async () => {
  const upstream = await startUpstream();
  try {
    const ctx = makeCtx({ protocol: "REST" });
    await assert.rejects(
      invoke(ctx, { type: "HTTP_PROXY", timeout_ms: 15000 }, {
        method: "GET",
        url: `${upstream.url}/large/11`,
        headers: new Headers(),
      }, ports),
      (error) => error instanceof GatewayError && error.type === "DEFAULT_5XX" && error.statusCode === 502,
    );
  } finally {
    await upstream.close();
  }
});

test("S04: error mapping unit — timeout shapes differ by protocol", () => {
  const rest = mapInvocationError(new GatewayError("INTEGRATION_TIMEOUT", "Endpoint request timed out"), "REST");
  assert.equal(rest.type, "INTEGRATION_TIMEOUT");
  assert.equal(rest.statusCode, 504);
  const http = mapInvocationError(new GatewayError("INTEGRATION_TIMEOUT", "Endpoint request timed out"), "HTTP");
  assert.equal(http.statusCode, 503);
});
