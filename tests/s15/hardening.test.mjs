/**
 * S15 part 1 (security): follow-up close-outs F4, F23, F36, F34, F41.
 *
 * - F4: `PODS_ALLOW_LOOPBACK` / `integration.allowLoopback` refused or ignored
 *   when `NODE_ENV=production` (fail fast at startup).
 * - F23: timing-safe webhook signature compare; connector token without modulo
 *   bias; streamed private-connector responses.
 * - F36: real connector-ingress path for PRIVATE APIs; the test-only
 *   `x-pods-test-ingress` / `x-pods-test-client-cert` hatches are impossible to
 *   enable when `NODE_ENV=production`. Runtime test without the test header.
 * - F34: private custom-domain policy + access associations enforced at runtime.
 * - F41: OpenAPI import runs the same per-field validation as the management
 *   services before writing; `failOnWarnings` semantics unchanged.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { MemoryKvStore } from "../../lib/gateway/state/memory-kv.mjs";
import { createMemoryLoader } from "../../gateway/loader.mjs";
import { createGatewayServer } from "../../gateway/server.mjs";
import { verifyWebhookSignature, signWebhookBody } from "../../lib/gateway/core/integrations/function.mjs";

process.env.PODS_ALLOW_LOOPBACK = "1";

const PRIVATE_POLICY = {
  Version: "2012-10-17",
  Statement: [{
    Effect: "Allow",
    Principal: "*",
    Action: "execute-api:Invoke",
    Resource: "execute-api:/*",
    Condition: { StringEquals: { "aws:SourceVpce": "conn-a" } },
  }],
};

async function compiledPrivateArtifact({ apiPublicId = "priv123456", edge = {}, settings = {} } = {}) {
  const { compile } = await import("../../lib/gateway/artifact/compile.mjs");
  const { artifact, errors } = compile({
    projectId: "proj-f",
    apiId: "api-priv",
    apiPublicId,
    protocol: "REST",
    settings: { resourcePolicy: PRIVATE_POLICY, ...settings },
    resources: [{ id: "res-root", path: "/" }],
    methods: [{
      id: "m1", resourceId: "res-root", httpMethod: "GET",
      authorizationType: "NONE", integrationId: "int1",
    }],
    integrations: [{ id: "int1", type: "MOCK", uri: null, timeoutMs: 5000 }],
    edge: { endpointType: "PRIVATE", ...edge },
  });
  assert.equal(errors.length, 0, `compile errors: ${JSON.stringify(errors)}`);
  return artifact;
}

test("F4: PODS_ALLOW_LOOPBACK / integration.allowLoopback refused or ignored when NODE_ENV=production", async () => {
  const { createProductionPorts } = await import("../../gateway/server.mjs");
  const kv = new MemoryKvStore({});
  assert.throws(
    () => createProductionPorts({ env: { ...process.env, NODE_ENV: "production", PODS_ALLOW_LOOPBACK: "1" }, kv }),
    /PODS_ALLOW_LOOPBACK/,
  );
  assert.throws(
    () => createProductionPorts({ env: { ...process.env, NODE_ENV: "production", PODS_ALLOW_LOOPBACK: "true" }, kv }),
    /PODS_ALLOW_LOOPBACK/,
  );
  // Unset/0 stays fine (other required-env errors may fire first; the
  // loopback refusal specifically must not).
  try {
    createProductionPorts({ env: { ...process.env, NODE_ENV: "production", PODS_ALLOW_LOOPBACK: "0" }, kv });
  } catch (error) {
    assert.doesNotMatch(String(error?.message ?? error), /PODS_ALLOW_LOOPBACK/);
  }

  // Engine defense in depth: the per-integration flag is ignored in prod.
  const { invokeHttp } = await import("../../lib/gateway/core/integrations/http.mjs");
  const realNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    const ctx = {
      artifact: { protocol: "REST" },
      request: new Request("http://gw.test/"),
      context: { identity: {} },
      signal: new AbortController().signal,
    };
    await assert.rejects(
      invokeHttp(
        ctx,
        { uri: "http://127.0.0.1:9/x", timeout_ms: 500, allowLoopback: true },
        { method: "GET", url: "http://127.0.0.1:9/x", headers: new Headers(), body: null },
        { log() {} },
        { lookup: async () => ["127.0.0.1"], selfHosts: [] },
      ),
      (error) => error?.code === "PODS_SSRF_BLOCKED",
    );
  } finally {
    if (realNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = realNodeEnv;
  }
});

test("F23: timing-safe webhook signature compare; connector token without modulo bias; streamed connector responses", async () => {
  const secret = "webhook-secret-f23";
  const body = JSON.stringify({ hello: "world" });
  const nowSec = Math.floor(Date.now() / 1000);
  const good = signWebhookBody(secret, body, nowSec);
  assert.equal(verifyWebhookSignature(secret, body, good, nowSec), true);
  assert.equal(verifyWebhookSignature(secret, `${body} `, good, nowSec), false);
  assert.equal(verifyWebhookSignature(secret, body, "t=1,v1=00", nowSec), false);
  assert.equal(verifyWebhookSignature(secret, body, "garbage", nowSec), false);
  assert.equal(verifyWebhookSignature("wrong-secret", body, good, nowSec), false);
  // Stale timestamps rejected inside the ±5 min window logic.
  assert.equal(verifyWebhookSignature(secret, body, signWebhookBody(secret, body, nowSec - 301), nowSec), false);
  assert.equal(verifyWebhookSignature(secret, body, signWebhookBody(secret, body, nowSec - 299), nowSec), true);

  // Connector tokens: shape + no modulo bias (uniform base62 over 32 chars).
  const { createConnectorToken, hashConnectorToken, CONNECTOR_TOKEN_PREFIX } = await import("../../lib/control/connectors.mjs");
  const seen = new Set();
  const counts = new Map();
  const db = {
    async getInheritedRole() { return "admin"; },
    async listRoleBindings() { return { roles: [], grants: [] }; },
    async getConnectorById(id) { return { id, project_id: "p1", deleted_at: null }; },
    async listConnectorTokens() { return []; },
    async insertConnectorToken(row) { return { ...row, id: `tok-${seen.size}`, created_at: new Date().toISOString() }; },
    async insertAudit() {},
  };
  const actor = { type: "user", userId: "u1" };
  for (let i = 0; i < 200; i += 1) {
    const created = await createConnectorToken(db, actor, { projectId: "p1", connectorId: "conn-1" });
    const token = created.body.token;
    assert.ok(token.startsWith(CONNECTOR_TOKEN_PREFIX));
    assert.equal(token.length, CONNECTOR_TOKEN_PREFIX.length + 32);
    seen.add(token);
    const first = token[CONNECTOR_TOKEN_PREFIX.length];
    counts.set(first, (counts.get(first) ?? 0) + 1);
  }
  assert.equal(seen.size, 200, "tokens must be unique");
  assert.equal(hashConnectorToken([...seen][0]).length, 64);
  // Rough uniformity: every observed char class appears; no single char owns >25%.
  for (const [, count] of counts) {
    assert.ok(count / 200 < 0.25, `token char distribution skewed: ${count}/200`);
  }

  // Private-connector responses stream chunk-by-chunk (no 10 MB buffer).
  const { createHub, encodeDataFrame } = await import("../../lib/gateway/core/integrations/connector.mjs");
  const hub = createHub({});
  const sent = [];
  const fakeWs = {
    send(frame) { sent.push(typeof frame === "string" ? JSON.parse(frame) : frame); },
    on() {},
    close() {},
  };
  const agent = hub.attachSocket(fakeWs, { connectorId: "conn-1", allowedTargets: ["internal:80"] });
  const chunks = [];
  const pending = hub.invokeStream
    ? hub.invokeStream("conn-1", { method: "GET", url: "http://internal:80/big", headers: {}, body: null }, {
      timeoutMs: 2000,
      onChunk: (chunk) => chunks.push(Buffer.from(chunk).byteLength),
    })
    : null;
  assert.ok(pending, "hub.invokeStream must exist (F23)");
  // Drive the agent side: response-head then two data frames then end.
  const open = sent.find((frame) => frame?.type === "open");
  assert.ok(open, "expected an open frame");
  hub.receive(agent, JSON.stringify({ type: "response-head", streamId: open.streamId, status: 200, headers: {} }));
  hub.receive(agent, encodeDataFrame(open.streamId, Buffer.from("hello ")));
  hub.receive(agent, encodeDataFrame(open.streamId, Buffer.from("world")));
  hub.receive(agent, JSON.stringify({ type: "end", streamId: open.streamId }));
  const result = await pending;
  assert.equal(result.status, 200);
  assert.deepEqual(chunks, [6, 5], "chunks must stream incrementally");
});

test("F36 [runtime]: real connector-ingress reaches PRIVATE APIs without the test header; test hatches dead in production", async () => {
  const artifact = await compiledPrivateArtifact();
  const stages = new Map([[`${artifact.apiPublicId}:prod`, { artifact }]]);
  const loader = createMemoryLoader({ pathRouting: true, stages });

  // Production-shaped server: even with allowTestIngress requested, the
  // test header must be ignored when NODE_ENV=production.
  const realNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  const prodGateway = createGatewayServer({ loader, ports: { allowTestIngress: true } });
  const prodPort = await prodGateway.start(0);
  try {
    const viaTestHeader = await fetch(`http://127.0.0.1:${prodPort}/${artifact.apiPublicId}/prod/`, {
      headers: { "x-pods-test-ingress": "conn-a" },
    });
    assert.equal(viaTestHeader.status, 403, "test ingress header must be dead in production");
    await viaTestHeader.arrayBuffer().catch(() => null);
  } finally {
    await prodGateway.close();
    if (realNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = realNodeEnv;
  }

  // Real connector-ingress path: an authenticated connector identity header,
  // verified through ports.connectorIngress, sets viaConnector (no test header).
  const gateway = createGatewayServer({
    loader,
    ports: {
      connectorIngress: {
        async verify({ connectorId, token }) {
          if (connectorId === "conn-a" && token === "good-token") {
            return { connectorId: "conn-a", sourceVpc: "vpc-a" };
          }
          return null;
        },
      },
    },
  });
  const port = await gateway.start(0);
  try {
    const noIngress = await fetch(`http://127.0.0.1:${port}/${artifact.apiPublicId}/prod/`);
    assert.equal(noIngress.status, 403);
    await noIngress.arrayBuffer().catch(() => null);

    const badToken = await fetch(`http://127.0.0.1:${port}/${artifact.apiPublicId}/prod/`, {
      headers: { "x-pods-connector-id": "conn-a", "x-pods-connector-token": "bad" },
    });
    assert.equal(badToken.status, 403);
    await badToken.arrayBuffer().catch(() => null);

    const good = await fetch(`http://127.0.0.1:${port}/${artifact.apiPublicId}/prod/`, {
      headers: { "x-pods-connector-id": "conn-a", "x-pods-connector-token": "good-token" },
    });
    assert.equal(good.status, 200, `connector ingress must reach the private API, got ${good.status}`);
    await good.arrayBuffer().catch(() => null);
  } finally {
    await gateway.close();
  }
});

test("F36: x-pods-test-client-cert hatch is dead when NODE_ENV=production", async () => {
  const { readFile } = await import("node:fs/promises");
  const caPem = await readFile(new URL("../s11/fixtures/certs/ca.pem", import.meta.url), "utf8");
  const leafPem = await readFile(new URL("../s11/fixtures/certs/client-good.pem", import.meta.url), "utf8");
  const { run } = await import("../../lib/gateway/core/phases/endpoint-access.mjs");
  const baseCtx = (ports) => ({
    request: new Request("https://gw.test/", {
      headers: { "x-pods-test-client-cert": encodeURIComponent(leafPem) },
    }),
    artifact: { protocol: "REST", edge: { mtls: { truststorePem: caPem } } },
    context: { identity: { sourceIp: "1.2.3.4" } },
    ports,
  });
  // Non-production: the hatch is honored and the trusted leaf passes.
  await run(baseCtx({ allowTestClientCert: true }));
  // Production: the hatch is dead even when requested — 403.
  const realNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    await assert.rejects(
      run(baseCtx({ allowTestClientCert: true })),
      (error) => error?.type === "ACCESS_DENIED",
    );
  } finally {
    if (realNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = realNodeEnv;
  }
});

test("F34 [runtime]: private custom-domain policy + access associations enforced", async () => {
  const artifact = await compiledPrivateArtifact({ apiPublicId: "f34api1234" });
  const stages = new Map([[`${artifact.apiPublicId}:prod`, { artifact }]]);
  const loader = createMemoryLoader({
    pathRouting: true,
    stages,
    customDomains: [{
      domainName: "priv.example.com",
      status: "AVAILABLE",
      endpointType: "PRIVATE",
      policy: PRIVATE_POLICY,
      associatedConnectorIds: ["conn-a"],
      routingMode: "API_MAPPING_ONLY",
      mappings: [{ apiPublicId: artifact.apiPublicId, stage: "prod", basePath: "" }],
      rules: [],
    }],
  });
  const gateway = createGatewayServer({
    loader,
    ports: {
      connectorIngress: {
        async verify({ connectorId, token }) {
          if (token === "good-token") return { connectorId, sourceVpc: "vpc-a" };
          return null;
        },
      },
    },
  });
  const port = await gateway.start(0);
  const { default: http } = await import("node:http");
  const getWithHost = (path, host, headers = {}) => new Promise((resolve, reject) => {
    const request = http.request(
      { host: "127.0.0.1", port, path, method: "GET", headers: { host, ...headers } },
      (response) => {
        let body = "";
        response.on("data", (chunk) => { body += chunk; });
        response.on("end", () => resolve({ status: response.statusCode, body }));
      },
    );
    request.once("error", reject);
    request.end();
  });
  try {
    // No ingress at all → 403.
    const direct = await getWithHost("/", "priv.example.com");
    assert.equal(direct.status, 403);

    // Associated connector via the real ingress path → 200.
    const good = await getWithHost("/", "priv.example.com", {
      "x-pods-connector-id": "conn-a",
      "x-pods-connector-token": "good-token",
    });
    assert.equal(good.status, 200, `associated connector must pass, got ${good.status} ${good.body}`);

    // Non-associated connector → 403 even with valid ingress auth.
    const other = await getWithHost("/", "priv.example.com", {
      "x-pods-connector-id": "conn-b",
      "x-pods-connector-token": "good-token",
    });
    assert.equal(other.status, 403, "unassociated connector must be denied");
  } finally {
    await gateway.close();
  }
});

test("F41: OpenAPI import runs management-service validation before writing; failOnWarnings unchanged", async () => {
  const { importNewApi, importExistingApi } = await import("../../lib/control/openapi-import.mjs");
  const { HttpError } = await import("../../lib/control/errors.mjs");
  const seen = { writes: 0 };
  const db = {
    async getInheritedRole() { return "admin"; },
    async listRoleBindings() { return { roles: [], grants: [] }; },
    async insertAudit() {},
    async getApiByName() { return null; },
    async insertApi(row) { return { ...row, id: "api-new", version: 1 }; },
    async getApiByRef({ ref }) {
      if (ref === "api-new") return { id: "api-new", project_id: "p1", public_id: "new1234567", protocol: "REST", version: 1 };
      return null;
    },
    async updateApi({ id, patch }) { return { id, ...patch }; },
    async listMethodsByApi() { return []; },
    async listResourcesByApi() { return [{ id: "res-root", path: "/" }]; },
    async listRoutesByApi() { return []; },
    async listIntegrations() { return []; },
    async listModels() { return []; },
    async listAuthorizers() { return []; },
    async insertResource(row) { seen.writes += 1; return { ...row, id: `res-${seen.writes}` }; },
    async insertIntegration(row) { seen.writes += 1; return { ...row, id: `int-${seen.writes}` }; },
    async insertMethod(row) { seen.writes += 1; return { ...row, id: `m-${seen.writes}` }; },
    async insertModel(row) { seen.writes += 1; return { ...row, id: `mod-${seen.writes}` }; },
    async insertAuthorizer(row) { seen.writes += 1; return { ...row, id: `a-${seen.writes}` }; },
  };
  const actor = { type: "user", userId: "u1" };
  const { createApi } = await import("../../lib/control/apis.mjs").catch(() => ({}));
  void createApi;

  const ssrfDoc = {
    openapi: "3.0.3",
    info: { title: "evil", version: "1" },
    paths: {
      "/x": {
        get: {
          responses: { 200: { description: "ok" } },
          "x-amazon-apigateway-integration": { type: "http_proxy", httpMethod: "GET", uri: "http://169.254.169.254/latest/meta-data/" },
        },
      },
    },
  };
  await assert.rejects(
    importNewApi(db, actor, { projectId: "p1", body: { document: ssrfDoc }, options: { protocol: "REST" } }),
    (error) => error instanceof HttpError && error.status === 422,
  );
  assert.equal(seen.writes, 0, "malicious import must write nothing");

  const crlfDoc = {
    openapi: "3.0.3",
    info: { title: "evil2", version: "1" },
    paths: {
      "/x": {
        get: {
          parameters: [{ name: "x-evil", in: "header", required: false }],
          responses: { 200: { description: "ok" } },
          "x-amazon-apigateway-integration": {
            type: "http",
            httpMethod: "GET",
            uri: "https://example.com/x",
            requestParameters: { "integration.request.header.x-evil": "'a\r\nInjected: 1'" },
          },
        },
      },
    },
  };
  await assert.rejects(
    importNewApi(db, actor, { projectId: "p1", body: { document: crlfDoc }, options: { protocol: "REST" } }),
    (error) => error instanceof HttpError && error.status === 422,
  );
  assert.equal(seen.writes, 0, "CRLF import must write nothing");

  // failOnWarnings semantics unchanged: warnings still warn (not errors)
  // and failOnWarnings still turns them into 400 import_warnings.
  const warnDoc = {
    openapi: "3.0.3",
    info: { title: "warn", version: "1" },
    "x-amazon-apigateway-bogus-extension": { whatever: true },
    paths: {
      "/x": {
        get: {
          responses: { 200: { description: "ok" } },
          "x-amazon-apigateway-integration": { type: "http_proxy", httpMethod: "GET", uri: "https://example.com/x" },
        },
      },
    },
  };
  await assert.rejects(
    importNewApi(db, actor, { projectId: "p1", body: { document: warnDoc }, options: { protocol: "REST", failOnWarnings: true } }),
    (error) => error instanceof HttpError && error.status === 400 && error.code === "import_warnings",
  );
  void importExistingApi;
});

test("F23 [runtime]: STREAM transfer through a private connector streams without buffering", async () => {
  const { createHub, encodeDataFrame } = await import("../../lib/gateway/core/integrations/connector.mjs");
  const { handle } = await import("../../lib/gateway/core/index.mjs");
  const hub = createHub({});
  let agent = null;
  const fakeWs = {
    send(frame) {
      const msg = typeof frame === "string" ? JSON.parse(frame) : null;
      if (msg?.type === "open" && agent) {
        const streamId = msg.streamId;
        setImmediate(() => {
          hub.receive(agent, JSON.stringify({ type: "response-head", streamId, status: 200, headers: { "content-type": "text/plain" } }));
          hub.receive(agent, encodeDataFrame(streamId, Buffer.from("chunk-one ")));
          hub.receive(agent, encodeDataFrame(streamId, Buffer.from("chunk-two")));
          hub.receive(agent, JSON.stringify({ type: "end", streamId }));
        });
      }
    },
    on() {},
    close() {},
  };
  agent = hub.attachSocket(fakeWs, { connectorId: "conn-1", allowedTargets: ["internal:80"] });
  const artifact = {
    schemaVersion: 1,
    projectId: "proj-f23",
    apiId: "api-f23",
    apiPublicId: "f231234567",
    protocol: "REST",
    stage: "prod",
    settings: {},
    resources: [{
      id: "res-big",
      path: "/big",
      methods: { GET: { id: "m1", auth: { type: "NONE" }, apiKeyRequired: false, integrationId: "int1" } },
    }],
    integrations: {
      int1: {
        id: "int1",
        type: "HTTP_PROXY",
        uri: "http://internal:80/big",
        integration_method: "GET",
        timeout_ms: 5000,
        connection_type: "CONNECTOR",
        connector_id: "conn-1",
        responseTransferMode: "STREAM",
      },
    },
    authorizers: {},
    models: {},
  };
  const ports = {
    kv: new MemoryKvStore({}),
    events: { emit() {} },
    secrets: { async resolve() { throw new Error("no secrets"); } },
    connectorHub: hub,
  };
  const response = await handle(new Request("http://gw.test/big"), artifact, ports);
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.equal(text, "chunk-one chunk-two");
  hub.close();
});
