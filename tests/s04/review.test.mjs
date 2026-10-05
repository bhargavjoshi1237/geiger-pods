import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
import { GatewayError } from "../../lib/gateway/core/errors.mjs";
import { buildContext } from "../../lib/gateway/core/context.mjs";
import { invoke } from "../../lib/gateway/core/integrations/index.mjs";
import { invokeHttp } from "../../lib/gateway/core/integrations/http.mjs";
import {
  buildHttpEvent,
  buildRestEvent,
} from "../../lib/gateway/core/integrations/function.mjs";
import {
  applyBackendAuth,
  clearSecretCache,
  getOAuthToken,
} from "../../lib/gateway/core/integrations/backend-auth.mjs";
import { buildSubtypeRequest } from "../../lib/gateway/core/integrations/aws.mjs";
import { acceptAgentSocket, createHub } from "../../lib/gateway/core/integrations/connector.mjs";
import { startAgent } from "../../connector/agent.mjs";
import {
  createConnector,
  createConnectorToken,
} from "../../lib/control/connectors.mjs";
import { createIntegration, updateIntegration } from "../../lib/control/integrations.mjs";
import { MemoryKvStore } from "../../lib/gateway/state/memory-kv.mjs";
import { startUpstream } from "../fixtures/upstream.mjs";

process.env.PODS_ALLOW_LOOPBACK = "1";

const PROJECT = "44444444-4444-4444-8444-444444444444";
const REST_API = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function engineCtx({ protocol = "REST", method = "GET", url = "https://gw.test/prod/x" } = {}) {
  const ctx = buildContext(new Request(url, { method, headers: new Headers() }), {
    protocol, apiId: "abc123def4", stage: "prod", projectId: "proj-1",
  }, {});
  ctx.signal = new AbortController().signal;
  ctx.pathParams = {};
  ctx.greedyParams = [];
  ctx.stageVariables = {};
  return ctx;
}

/** Actor holding only pods.integration.write (no pods.secret.use). */
const BUILDER = { type: "user", userId: "u-builder" };

function builderDb() {
  const store = { integrations: new Map(), audits: [] };
  return {
    async getInheritedRole() { return null; },
    async listRoleBindings() {
      return {
        roles: [{ id: "r-build", key: "builder", name: "Builder", permissions: ["pods.integration.write"] }],
        grants: [{ id: "g-build", roleId: "r-build", userId: "u-builder", projectId: PROJECT, scope: {}, status: "active" }],
      };
    },
    async insertAudit(entry) { store.audits.push(entry); },
    async getApiProtocol() { return "REST"; },
    async listIntegrations() { return []; },
    async getIntegrationById(id) { return store.integrations.get(id) ?? null; },
    async insertIntegration(row) {
      const saved = {
        id: randomUUID(), created_at: "2026-10-05T00:00:01.000Z",
        updated_at: "2026-10-05T00:00:01.000Z", deleted_at: null, version: 1, ...row,
      };
      store.integrations.set(saved.id, saved);
      return saved;
    },
    async updateIntegration(id, patch) {
      Object.assign(store.integrations.get(id), patch, { version: store.integrations.get(id).version + 1 });
      return store.integrations.get(id);
    },
  };
}

function adminDb() {
  const db = builderDb();
  db.getInheritedRole = async () => "admin";
  db.listRoleBindings = async () => ({ roles: [], grants: [] });
  return db;
}

test("S04 review: ANY /{proxy+} with {proxy} in URI does not double-append path", async () => {
  const upstream = await startUpstream();
  try {
    const ctx = engineCtx({ protocol: "HTTP", url: "https://gw.test/prod/a/b" });
    ctx.routeKey = "ANY /{proxy+}";
    ctx.pathParams = { proxy: "a/b" };
    ctx.greedyParams = ["proxy"];
    const result = await invokeHttp(ctx, {
      type: "HTTP_PROXY", uri: `${upstream.url}/{proxy}`, timeout_ms: 5000,
    }, { method: "GET", url: null, headers: new Headers() }, { log() {} });
    const seen = JSON.parse(Buffer.from(result.body).toString("utf8"));
    assert.equal(seen.path, "/a/b");
  } finally {
    await upstream.close();
  }
});

test("S04 review: query string passes through when rendering from uri template", async () => {
  const upstream = await startUpstream();
  try {
    const ctx = engineCtx({ url: "https://gw.test/prod/items?tag=9" });
    const result = await invokeHttp(ctx, {
      type: "HTTP_PROXY", uri: `${upstream.url}/echo`, timeout_ms: 5000,
    }, { method: "GET", url: null, headers: new Headers() }, { log() {} });
    const seen = JSON.parse(Buffer.from(result.body).toString("utf8"));
    assert.equal(seen.query, "?tag=9");
  } finally {
    await upstream.close();
  }
});

test("S04 review: webhook function does not follow redirects", async () => {
  const upstream = await startUpstream();
  try {
    const ctx = engineCtx({});
    await assert.rejects(
      invoke(ctx, {
        type: "FUNCTION_PROXY",
        function: { provider: "webhook", url: `${upstream.url}/redirect` },
        payload_format_version: "1.0",
      }, {}, { fetch: globalThis.fetch }),
      (error) => error instanceof GatewayError,
    );
    assert.equal(upstream.requests.filter((entry) => entry.path === "/final").length, 0);
  } finally {
    await upstream.close();
  }
});

test("S04 review: __proto__ header/query keys cannot crash function event builders", () => {
  const ctx = engineCtx({});
  // Own (non-prototype) __proto__ data property, as produced by
  // Object.fromEntries / URLSearchParams on attacker-controlled input.
  const evilHeaders = {};
  Object.defineProperty(evilHeaders, "__proto__", {
    value: "evil", enumerable: true, configurable: true, writable: true,
  });
  evilHeaders["x-a"] = "b";
  ctx.request = {
    url: "https://gw.test/prod/x?__proto__=polluted&ok=1",
    method: "GET",
    headers: evilHeaders,
  };
  const rest = buildRestEvent(ctx, {});
  assert.equal(Object.getPrototypeOf(rest.multiValueHeaders), null);
  assert.equal(Object.getPrototypeOf(rest.multiValueQueryStringParameters), null);
  assert.deepEqual(rest.multiValueQueryStringParameters.ok, ["1"]);
  assert.equal(Object.hasOwn(rest.multiValueQueryStringParameters, "__proto__"), true);
  // No global pollution through Object.prototype.
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal({}.polluted, undefined);

  const http = buildHttpEvent(ctx, { version: "2.0" });
  assert.equal(Object.getPrototypeOf(http.headers), null);
  // queryStringParameters is a spread copy: normal prototype, but __proto__
  // is an own data property — never a prototype mutation.
  assert.equal(Object.getPrototypeOf(http.queryStringParameters), Object.prototype);
  assert.equal(Object.hasOwn(http.queryStringParameters, "__proto__"), true);
  assert.equal({}.polluted, undefined);
});

test("S04 review: payload 2.0 splits Cookie header into cookies array", () => {
  const request = new Request("https://gw.test/prod/x", { headers: { cookie: "a=1; b=2" } });
  const ctx = buildContext(request, { protocol: "HTTP", apiId: "a", stage: "prod" }, {});
  const event = buildHttpEvent(ctx, { version: "2.0" });
  assert.deepEqual(event.cookies, ["a=1", "b=2"]);
});

test("S04 review: payload 2.0 time uses CLF requestTime", () => {
  const ctx = engineCtx({ protocol: "HTTP" });
  const event = buildHttpEvent(ctx, { version: "2.0" });
  assert.equal(event.requestContext.time, ctx.context.requestTime);
  assert.match(event.requestContext.time, /^\d{2}\/[A-Za-z]{3}\/\d{4}:\d{2}:\d{2}:\d{2} \+0000$/);
});

test("S04 review: FUNCTION custom aws_lambda uses renderedTemplate", async () => {
  let seenBody = null;
  let seenHeaders = null;
  const ports = {
    fetch: async (url, init) => {
      seenBody = init.body;
      seenHeaders = init.headers;
      return new Response(JSON.stringify({ statusCode: 200, body: "{}" }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    },
    secrets: {
      async resolve() {
        return { kind: "aws_credentials", value: { accessKeyId: "AKID", secretAccessKey: "SECRET" } };
      },
    },
  };
  const ctx = engineCtx({});
  await invoke(ctx, {
    type: "FUNCTION",
    function: {
      provider: "aws_lambda",
      functionArn: "arn:aws:lambda:us-east-1:123456789012:function:pods-fn",
      credentialsRef: "secret:creds",
    },
  }, { renderedTemplate: '{"custom":true}' }, ports);
  assert.equal(seenBody, '{"custom":true}');
  assert.match(seenHeaders.authorization ?? "", /^AWS4-HMAC-SHA256 /);
});

test("S04 review: AWS subtype config errors are API_CONFIGURATION_ERROR", async () => {
  assert.throws(
    () => buildSubtypeRequest("SQS-SendMessage", { QueueUrl: "q" }, { region: "us-east-1" }),
    (error) => error instanceof GatewayError && error.type === "API_CONFIGURATION_ERROR",
  );
  const ctx = engineCtx({});
  await assert.rejects(
    invoke(ctx, {
      type: "AWS_SERVICE",
      aws: { subtype: "SQS-SendMessage", region: "us-east-1", roleSecretRef: "secret:aws1" },
    }, { awsParams: { QueueUrl: "q" } }, {
      fetch: async () => new Response("{}", { status: 200 }),
      secrets: { async resolve() { return { value: { accessKeyId: "AKID", secretAccessKey: "S" } }; } },
    }),
    (error) => error instanceof GatewayError && error.type === "API_CONFIGURATION_ERROR" && error.statusCode === 500,
  );
});

test("S04 review: aws_service fetch does not follow redirects", async () => {
  let seenInit = null;
  const ctx = engineCtx({});
  await invoke(ctx, {
    type: "AWS_SERVICE",
    aws: { subtype: "SQS-SendMessage", region: "us-east-1", roleSecretRef: "secret:aws1" },
  }, { awsParams: { QueueUrl: "https://sqs.us-east-1.amazonaws.com/123/q", MessageBody: "hi" } }, {
    fetch: async (url, init) => {
      seenInit = init;
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    },
    secrets: { async resolve() { return { value: { accessKeyId: "AKID", secretAccessKey: "S" } }; } },
  });
  assert.equal(seenInit?.redirect, "manual");
});

test("S04 review: query backend_auth with missing url fails masked, not TypeError", async () => {
  clearSecretCache();
  const error = await applyBackendAuth(
    { headers: new Headers(), url: null },
    { type: "query", secretRef: "secret:up1", headerName: "api_key" },
    { secrets: { async resolve() { return { kind: "generic", value: { value: "s3cr3t" } }; } } },
  ).then(() => null, (failure) => failure);
  assert.ok(error, "expected backend auth to fail");
  assert.equal(error.code, "backend_auth_failed");
  assert.match(error.message, /\*\*\*\*/);
  assert.ok(!error.message.includes("s3cr3t"));
});

test("S04 review: query backend_auth applies to the rendered integration url", async () => {
  clearSecretCache();
  const upstream = await startUpstream();
  try {
    const ports = {
      fetch: globalThis.fetch,
      secrets: { async resolve() { return { kind: "generic", value: { value: "s3cr3t" } }; } },
      log() {},
    };
    const ctx = engineCtx({});
    const result = await invoke(ctx, {
      type: "HTTP_PROXY",
      uri: `${upstream.url}/echo`,
      timeout_ms: 5000,
      backend_auth: { type: "query", secretRef: "secret:up1", headerName: "api_key" },
    }, { method: "GET", url: null, headers: new Headers() }, ports);
    assert.equal(result.status, 200);
    const seen = JSON.parse(Buffer.from(result.body).toString("utf8"));
    assert.match(seen.query, /api_key=s3cr3t/);
  } finally {
    await upstream.close();
  }
});

test("S04 review: function/aws secret refs require pods.secret.use", async () => {
  for (const input of [
    { type: "FUNCTION_PROXY", function: { provider: "webhook", url: "https://b.example.com/fn", secretRef: "secret:abc" } },
    {
      type: "FUNCTION_PROXY",
      function: { provider: "aws_lambda", functionArn: "arn:aws:lambda:us-east-1:123456789012:function:f", credentialsRef: "secret:abc" },
    },
    { type: "AWS_SERVICE", aws: { service: "sqs", region: "us-east-1", action: "SendMessage", roleSecretRef: "secret:abc" } },
  ]) {
    await assert.rejects(
      createIntegration(builderDb(), BUILDER, { projectId: PROJECT, apiId: REST_API, input }),
      (error) => error.status === 403,
      `expected 403 for ${JSON.stringify(input).slice(0, 80)}`,
    );
  }
  const db = builderDb();
  const created = await createIntegration(db, BUILDER, {
    projectId: PROJECT, apiId: REST_API, input: { type: "MOCK" },
  });
  await assert.rejects(
    updateIntegration(db, BUILDER, {
      projectId: PROJECT, apiId: REST_API, integrationId: created.body.id,
      patch: { backendAuth: { type: "bearer", secretRef: "secret:abc" } }, expectedVersion: 1,
    }),
    (error) => error.status === 403,
  );
});

test("S04 review: tls serverNameToVerify null round-trips", async () => {
  const created = await createIntegration(adminDb(), { type: "user", userId: "u-a" }, {
    projectId: PROJECT,
    apiId: REST_API,
    input: {
      type: "HTTP_PROXY",
      uri: "https://b.example.com/x",
      tls: { insecureSkipVerification: false, serverNameToVerify: null },
    },
  });
  assert.equal(created.status, 201);
});

test("S04 review: CONNECTOR integrations require a uri", async () => {
  await assert.rejects(
    createIntegration(adminDb(), { type: "user", userId: "u-a" }, {
      projectId: PROJECT,
      apiId: REST_API,
      input: {
        type: "HTTP_PROXY",
        connectionType: "CONNECTOR",
        connectorId: "11111111-1111-4111-8111-111111111111",
      },
    }),
    (error) => error.status === 422,
  );
});

test("S04 review: uri with host placeholder is rejected", async () => {
  await assert.rejects(
    createIntegration(adminDb(), { type: "user", userId: "u-a" }, {
      projectId: PROJECT, apiId: REST_API, input: { type: "HTTP_PROXY", uri: "https://{host}/x" },
    }),
    (error) => error.status === 422,
  );
});

test("S04 review: connector target port range is validated", async () => {
  const db = {
    async getInheritedRole() { return "admin"; },
    async listRoleBindings() { return { roles: [], grants: [] }; },
    async insertAudit() {},
    async insertConnector(row) {
      return {
        id: randomUUID(), created_at: "", updated_at: "", deleted_at: null,
        version: 1, status: "PENDING", allowed_targets: row.allowed_targets, ...row,
      };
    },
  };
  await assert.rejects(
    createConnector(db, { type: "user", userId: "u-a" }, {
      projectId: PROJECT, input: { name: "bad-port", allowedTargets: ["internal:99999"] },
    }),
    (error) => error.status === 422,
  );
});

test("S04 review: SSRF block maps to API_CONFIGURATION_ERROR on the default path", async () => {
  const ctx = engineCtx({});
  await assert.rejects(
    invokeHttp(ctx, { type: "HTTP_PROXY", timeout_ms: 8000 }, {
      method: "GET", url: "http://169.254.169.254/latest/meta-data/", headers: new Headers(),
    }, { log() {} }, {}),
    (error) => error.code === "PODS_SSRF_BLOCKED",
  );
  const ctx2 = engineCtx({});
  await assert.rejects(
    invoke(ctx2, { type: "HTTP_PROXY", timeout_ms: 8000 }, {
      method: "GET", url: "http://169.254.169.254/latest/meta-data/", headers: new Headers(),
    }, { log() {} }),
    (error) => error instanceof GatewayError && error.type === "API_CONFIGURATION_ERROR",
  );
});

test("S04 review: oauth token fetch does not follow redirects", async () => {
  let seenInit = null;
  const token = await getOAuthToken(
    { tokenUrl: "https://auth.example.com/token", clientId: "c", clientSecret: "s" },
    {
      fetch: async (url, init) => {
        seenInit = init;
        return new Response(JSON.stringify({ access_token: "tok-x", expires_in: 3600 }), { status: 200 });
      },
      kv: null,
    },
  );
  assert.equal(token, "tok-x");
  assert.equal(seenInit?.redirect, "manual");
});

function waitFor(condition, timeoutMs = 8000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      let ok = false;
      try {
        ok = condition();
      } catch {
        ok = false;
      }
      if (ok) {
        resolve();
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error("Timed out waiting for condition."));
        return;
      }
      setTimeout(poll, 25);
    };
    poll();
  });
}

test("S04 review: connector tunnel does not follow redirects", async (t) => {
  const privateNet = await startUpstream();
  const allow = [`127.0.0.1:${privateNet.port}`];
  const hub = createHub();
  const gateway = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  gateway.on("connection", (ws) => {
    acceptAgentSocket(hub, ws, {
      lookupConnector: async (token) => (
        token === "token-1" ? { connectorId: "ctr-1", allowedTargets: allow } : null
      ),
    }).catch(() => {});
  });
  await new Promise((resolve) => gateway.on("listening", resolve));
  t.after(async () => {
    hub.close();
    await new Promise((resolve) => gateway.close(resolve));
    await privateNet.close();
  });
  const agent = await startAgent({
    url: `ws://127.0.0.1:${gateway.address().port}/_connector`,
    token: "token-1",
    allowedTargets: allow,
    reconnectDelayMs: 50,
  });
  t.after(() => agent.close());
  await waitFor(() => hub.agentCount("ctr-1") === 1);

  const result = await hub.invoke("ctr-1", {
    method: "GET", url: `${privateNet.url}/redirect`, headers: {}, body: null,
  }, { timeoutMs: 10000 });
  assert.equal(result.status, 302);
  assert.equal(privateNet.requests.filter((entry) => entry.path === "/final").length, 0);
});

test("S04 review: connector appends $default path and renders request.path tokens", async () => {
  let seenUrl = null;
  const hub = {
    invoke: async (id, outbound) => {
      seenUrl = outbound.url;
      return { status: 200, headers: new Headers(), body: new Uint8Array(0) };
    },
  };
  const ctx = engineCtx({ protocol: "HTTP", url: "https://gw.test/prod/orders/42" });
  ctx.routeKey = "$default";
  ctx.requestPathParams = { id: "7" };
  await invoke(ctx, {
    type: "HTTP_PROXY",
    connection_type: "CONNECTOR",
    connector_id: "ctr-1",
    uri: "https://internal.example.com/base/${request.path.id}",
    timeout_ms: 5000,
  }, { method: "GET", headers: new Headers() }, { connectorHub: hub, log() {} }, {
    connectorTargets: ["internal.example.com:443"],
  });
  assert.equal(seenUrl, "https://internal.example.com/base/7/orders/42");
});

test("S04 review: connector oauth refreshes once on 401", async () => {
  clearSecretCache();
  const upstream = await startUpstream();
  try {
    const kv = new MemoryKvStore();
    const ports = {
      fetch: globalThis.fetch,
      kv,
      secrets: {
        async resolve() {
          return {
            kind: "oauth_client",
            value: { tokenUrl: `${upstream.url}/token`, clientId: "pods-client", clientSecret: "s" },
          };
        },
      },
      log() {},
    };
    const calls = [];
    const hub = {
      invoke: async (id, outbound) => {
        calls.push({ ...(outbound.headers instanceof Headers ? Object.fromEntries(outbound.headers.entries()) : outbound.headers) });
        if (calls.length === 1) return { status: 401, headers: new Headers(), body: new Uint8Array(0) };
        return { status: 200, headers: new Headers(), body: new Uint8Array(0) };
      },
    };
    const ctx = engineCtx({});
    const result = await invoke(ctx, {
      type: "HTTP_PROXY",
      connection_type: "CONNECTOR",
      connector_id: "ctr-1",
      uri: "https://internal.example.com/echo",
      timeout_ms: 5000,
      backend_auth: { type: "oauth_client_credentials", secretRef: "secret:up1" },
    }, { method: "GET", headers: new Headers() }, ports, {
      connectorHub: hub,
      connectorTargets: ["internal.example.com:443"],
    });
    assert.equal(result.status, 200);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].authorization, "Bearer tok-1");
    assert.equal(calls[1].authorization, "Bearer tok-2");
    assert.equal(upstream.requests.filter((entry) => entry.path === "/token").length, 2);
  } finally {
    await upstream.close();
  }
});

test("S04 review: connector token lifecycle still shows once with prefix", async () => {
  const store = { connectors: new Map(), tokens: new Map(), audits: [] };
  const stamp = (row) => ({
    id: randomUUID(), created_at: "2026-10-05T00:00:01.000Z",
    updated_at: "2026-10-05T00:00:01.000Z", deleted_at: null, version: 1, ...row,
  });
  const db = {
    async getInheritedRole() { return "admin"; },
    async listRoleBindings() { return { roles: [], grants: [] }; },
    async insertAudit(entry) { store.audits.push(entry); },
    async getConnectorById(id) { return store.connectors.get(id) ?? null; },
    async insertConnector(row) {
      const saved = stamp(row);
      store.connectors.set(saved.id, saved);
      return saved;
    },
    async listConnectorTokens(connectorId) {
      return [...store.tokens.values()].filter((row) => row.connector_id === connectorId);
    },
    async insertConnectorToken(row) {
      const saved = stamp(row);
      store.tokens.set(saved.id, saved);
      return saved;
    },
  };
  const admin = { type: "user", userId: "u-a" };
  const created = await createConnector(db, admin, {
    projectId: PROJECT, input: { name: "tok-once", allowedTargets: [] },
  });
  const first = await createConnectorToken(db, admin, { projectId: PROJECT, connectorId: created.body.id });
  assert.match(first.body.token, /^pods_ctr_[A-Za-z0-9]{32}$/);
  assert.ok(!("token_hash" in first.body));
  const listed = await db.listConnectorTokens(created.body.id);
  assert.equal(listed.length, 1);
  assert.ok(!("token" in listed[0]));
});
