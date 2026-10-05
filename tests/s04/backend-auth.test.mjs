import assert from "node:assert/strict";
import test from "node:test";
import { buildContext } from "../../lib/gateway/core/context.mjs";
import { invoke } from "../../lib/gateway/core/integrations/index.mjs";
import { applyBackendAuth, clearSecretCache } from "../../lib/gateway/core/integrations/backend-auth.mjs";
import { MemoryKvStore } from "../../lib/gateway/state/memory-kv.mjs";
import { startUpstream } from "../fixtures/upstream.mjs";

process.env.PODS_ALLOW_LOOPBACK = "1";

const SECRET = "sk-live-9f8e7d6c5b4a";

function makeCtx({ protocol = "REST" } = {}) {
  const request = new Request("https://gw.test/prod/x", { headers: { "x-api-key": "client-value" } });
  const ctx = buildContext(request, { protocol, apiId: "abc123def4", stage: "prod", projectId: "p1" }, {});
  ctx.signal = new AbortController().signal;
  return ctx;
}

function secretPorts(kind, value) {
  return {
    resolve: async (ref) => {
      assert.equal(ref, "secret:up1");
      return { kind, value };
    },
  };
}

test("S04: backend_auth header overwrites client-supplied header; secret value never appears in ctx, logs or error bodies", async () => {
  clearSecretCache();
  const upstream = await startUpstream();
  try {
    const logged = [];
    const ports = {
      fetch: globalThis.fetch,
      kv: new MemoryKvStore(),
      secrets: secretPorts("header", { name: "x-api-key", value: SECRET }),
      log: (...args) => logged.push(args.map(String).join(" ")),
    };
    const ctx = makeCtx();
    const result = await invoke(ctx, {
      type: "HTTP_PROXY",
      timeout_ms: 5000,
      backend_auth: { type: "header", secretRef: "secret:up1", headerName: "x-api-key" },
    }, {
      method: "GET",
      url: `${upstream.url}/echo`,
      headers: new Headers({ "x-api-key": "client-value" }),
    }, ports);
    assert.equal(result.status, 200);
    const seen = JSON.parse(Buffer.from(result.body).toString("utf8"));
    assert.equal(seen.headers["x-api-key"], SECRET);

    const serialized = JSON.stringify({ context: ctx.context, integration: ctx.integration, logged });
    assert.ok(!serialized.includes(SECRET), "secret leaked into context or logs");

    // Failure paths mask the value too.
    clearSecretCache();
    const bad = await applyBackendAuth(
      { headers: new Headers(), url: `${upstream.url}/echo` },
      { type: "header", secretRef: "secret:missing" },
      { secrets: { async resolve() { throw new Error("not found"); } } },
    ).then(() => null, (error) => error);
    assert.ok(bad, "expected backend auth to fail");
    // The failure masks the secret and never echoes the resolver's error.
    assert.ok(!String(bad.message).includes("not found"));
    assert.ok(!JSON.stringify(bad).includes(SECRET));
    assert.match(bad.message, /\*\*\*\*/);
  } finally {
    await upstream.close();
  }
});

test("S04: oauth client-credentials token cached and refreshed once on 401", async () => {
  clearSecretCache();
  const upstream = await startUpstream();
  try {
    const kv = new MemoryKvStore();
    const ports = {
      fetch: globalThis.fetch,
      kv,
      secrets: secretPorts("oauth_client", {
        tokenUrl: `${upstream.url}/token`,
        clientId: "pods-client",
        clientSecret: "oauth-secret-value",
      }),
    };
    const auth = { type: "oauth_client_credentials", secretRef: "secret:up1" };
    const first = await invoke(makeCtx(), {
      type: "HTTP_PROXY", timeout_ms: 5000, backend_auth: auth,
    }, { method: "GET", url: `${upstream.url}/echo`, headers: new Headers() }, ports);
    assert.equal(first.status, 200);
    const firstSeen = JSON.parse(Buffer.from(first.body).toString("utf8"));
    assert.equal(firstSeen.headers.authorization, "Bearer tok-1");

    const second = await invoke(makeCtx(), {
      type: "HTTP_PROXY", timeout_ms: 5000, backend_auth: auth,
    }, { method: "GET", url: `${upstream.url}/echo`, headers: new Headers() }, ports);
    const secondSeen = JSON.parse(Buffer.from(second.body).toString("utf8"));
    assert.equal(secondSeen.headers.authorization, "Bearer tok-1");
    const tokenCalls = upstream.requests.filter((entry) => entry.path === "/token");
    assert.equal(tokenCalls.length, 1);

    // The backend 401s once: exactly one refresh + retry, then success.
    const flaky = await invoke(makeCtx(), {
      type: "HTTP_PROXY", timeout_ms: 5000, backend_auth: auth,
    }, { method: "GET", url: `${upstream.url}/auth-once`, headers: new Headers() }, ports);
    assert.equal(flaky.status, 200);
    const flakySeen = JSON.parse(Buffer.from(flaky.body).toString("utf8"));
    assert.equal(flakySeen.headers.authorization, "Bearer tok-2");
    assert.equal(upstream.requests.filter((entry) => entry.path === "/token").length, 2);
    assert.equal(upstream.requests.filter((entry) => entry.path === "/auth-once").length, 2);
  } finally {
    await upstream.close();
  }
});
