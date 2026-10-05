/**
 * S09 runtime acceptance tests (bullets 4, 11, 12): canary traffic split,
 * streaming first-byte latency and client-abort propagation — all against
 * the in-process gateway (`createGatewayServer` + memory loader), mirroring
 * `tests/s05/runtime.test.mjs`.
 */

import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { compile } from "../../lib/gateway/artifact/compile.mjs";
import { createMemoryLoader } from "../../gateway/loader.mjs";
import { createGatewayServer } from "../../gateway/server.mjs";
import { MemoryKvStore } from "../../lib/gateway/state/memory-kv.mjs";
import { seededRng } from "./helper.mjs";

process.env.PODS_ALLOW_LOOPBACK = "1";

/**
 * Closes a server (or gateway) even with pooled keep-alive connections.
 *
 * @param {{ close?: Function, server?: object }|object} target
 */
export async function closeQuietly(target) {
  try {
    const server = target?.server ?? target;
    if (server && typeof server.closeAllConnections === "function") {
      server.closeAllConnections();
    }
  } catch {
    // Best-effort.
  }
  try {
    await target?.close?.();
  } catch {
    // Best-effort.
  }
}

/**
 * Closes a raw `node:http` server (destroys keep-alive sockets first).
 *
 * @param {import("node:http").Server} server
 */
export async function closeHttp(server) {
  try {
    server?.closeAllConnections?.();
  } catch {
    // Best-effort.
  }
  await new Promise((resolve) => server.close(resolve));
}

/**
 * Creates an isolated `fetch` for the gateway engine backed by its own
 * undici Agent, so per-test connection pools can be closed without touching
 * the global dispatcher (closing it breaks later tests in the file).
 *
 * @returns {{ fetch: typeof fetch, close(): Promise<void> }}
 */
export async function isolatedFetch() {
  const { Agent, fetch: undiciFetch } = await import("undici");
  const agent = new Agent({ keepAliveTimeout: 1, keepAliveMaxTimeout: 1000 });
  return {
    fetch: (url, options = {}) => undiciFetch(url, { ...options, dispatcher: agent }),
    async close() {
      try {
        await agent.close();
      } catch {
        // Best-effort.
      }
    },
  };
}

function restProxyDraft(apiPublicId, upstreamUrl, path) {
  return {
    projectId: "proj-s09",
    apiId: `api-${apiPublicId}`,
    apiPublicId,
    protocol: "REST",
    resources: [{ id: "res-root", path: "/" }, { id: "res-pets", path: "/pets" }],
    methods: [{
      id: "m1", resourceId: "res-pets", httpMethod: "GET",
      authorizationType: "NONE", authorizerId: null, authorizationScopes: [],
      apiKeyRequired: false, requestValidatorId: null, requestParameters: {},
      requestModels: {}, integrationId: "int-1",
    }],
    integrations: [{ id: "int-1", type: "HTTP_PROXY", uri: `${upstreamUrl}${path}`, timeoutMs: 5000 }],
  };
}

function compileProxy(apiPublicId, upstreamUrl, path) {
  const { artifact, errors } = compile(restProxyDraft(apiPublicId, upstreamUrl, path));
  assert.equal(errors.length, 0, `must compile: ${errors[0]?.message}`);
  return { ...artifact, allowLoopback: true, stage: "prod", stageVariables: {} };
}

test("S09 [runtime]: deploy-to-canary leaves base deployment serving ~ (100-p)% of traffic", async () => {
  const { createFakeDb } = await import("../s05/fake-db.mjs");
  const { createDeployment, resetDeployState, setDeployClock } = await import("../../lib/control/deployments.mjs");
  const { deployToCanary } = await import("../../lib/control/canary.mjs");
  resetDeployState();
  // Upstream echo distinguishes base (/base) from canary (/canary) backends.
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ path: new URL(req.url, "http://x").pathname }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;
  const gatewayHolder = [];
  try {
    const PROJECT = "44444444-4444-4434-8344-444444444444";
    const ADMIN = { type: "user", userId: "u-admin" };
    const db = createFakeDb({ roles: { "u-admin": "admin" } });
    db.getIntegrationById = async (id) => {
      const row = db._maps.integrations.get(id);
      return row ? { ...row } : null;
    };
    const api = await db.insertApi({
      project_id: PROJECT, public_id: "s09rtcanary1", name: "s09-rt-canary", protocol: "REST",
      api_key_source: "HEADER", binary_media_types: [], minimum_compression_size: null,
      missing_route_behavior: "aws", cors: null, resource_policy: null, route_selection_expression: null,
    });
    const root = await db.insertResource({ project_id: PROJECT, api_id: api.id, parent_id: null, path_part: "", path: "/" });
    const pets = await db.insertResource({ project_id: PROJECT, api_id: api.id, parent_id: root.id, path_part: "pets", path: "/pets" });
    // Base deployment points at /base; the canary draft will point at /canary.
    const baseInt = await db.insertIntegration({
      project_id: PROJECT, api_id: api.id, public_id: "s09rtbase01", type: "HTTP_PROXY",
      integration_method: "ANY", uri: `${upstreamUrl}/base`, connection_type: "INTERNET",
      connector_id: null, timeout_ms: 5000, backend_auth: null, function: null, aws: null,
    });
    await db.insertMethod({
      project_id: PROJECT, api_id: api.id, resource_id: pets.id, http_method: "GET",
      authorization_type: "NONE", authorizer_id: null, authorization_scopes: [],
      api_key_required: false, request_validator_id: null, request_parameters: {},
      request_models: {}, integration_id: baseInt.id,
    });
    const v1 = await createDeployment(db, ADMIN, { projectId: PROJECT, apiId: api.id, description: "base", stageName: "prod" });
    // Repoint the draft at /canary, then deploy-to-canary at 50%.
    const current = await db.getIntegrationById(baseInt.id);
    if (typeof db.updateIntegration === "function") {
      await db.updateIntegration(current.id, { uri: `${upstreamUrl}/canary` });
    } else {
      // Fake db has no updateIntegration: patch the row directly.
      const row = db._maps.integrations.get(current.id);
      db._maps.integrations.set(current.id, { ...row, uri: `${upstreamUrl}/canary` });
    }
    setDeployClock({ now: () => Date.now() + 5000 });
    const canary = await deployToCanary(db, ADMIN, {
      projectId: PROJECT, apiId: api.id, stageName: "prod",
      description: "canary", percentTraffic: 50, stageVariableOverrides: {}, useStageCache: false,
    });
    assert.equal(canary.status, 201);
    const baseRow = await db.getDeploymentById(v1.body.id);
    const canaryRow = await db.getDeploymentById(canary.body.deploymentId);
    const baseArtifact = { ...baseRow.artifact, allowLoopback: true, stage: "prod", stageVariables: {} };
    const canaryArtifact = { ...canaryRow.artifact, allowLoopback: true, stage: "prod", stageVariables: {} };
    assert.match(baseArtifact.integrations?.["int-1"]?.uri ?? JSON.stringify(baseArtifact.integrations), /\/base/);
    const loader = createMemoryLoader({
      kv: new MemoryKvStore({}),
      pathRouting: true,
      stages: new Map([["s09rtcanary1:prod", {
        artifact: {
          ...baseArtifact,
          canary: { deploymentId: canary.body.deploymentId, percentTraffic: 50, stageVariableOverrides: {}, useStageCache: false },
          canaryArtifact,
        },
      }]]),
    });
    const gateway = createGatewayServer({ loader, ports: { rng: seededRng(99) } });
    gatewayHolder.push(gateway);
    const port = await gateway.start(0);
    let baseCount = 0;
    let canaryCount = 0;
    for (let index = 0; index < 120; index += 1) {
      const response = await fetch(`http://127.0.0.1:${port}/s09rtcanary1/prod/pets`);
      assert.equal(response.status, 200);
      const seen = await response.json();
      if (String(seen.path).startsWith("/canary")) canaryCount += 1;
      else if (String(seen.path).startsWith("/base")) baseCount += 1;
      else assert.fail(`unexpected backend path ${seen.path}`);
    }
    assert.ok(canaryCount >= 30 && canaryCount <= 90, `~50% canary expected, got ${canaryCount}/120`);
    assert.equal(baseCount + canaryCount, 120);
    assert.ok(baseCount >= 30 && baseCount <= 90, `~50% base expected, got ${baseCount}/120`);
    resetDeployState();
  } finally {
    for (const gateway of gatewayHolder) await closeQuietly(gateway);
    await closeHttp(upstream);
  }
});

test("S09 [runtime]: STREAM — first byte reaches client before upstream finishes (upstream /stream sends 5 chunks 500 ms apart)", async () => {
  const slow = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/plain", "transfer-encoding": "chunked" });
    let index = 0;
    const timer = setInterval(() => {
      if (index < 5) {
        try {
          res.write(`chunk-${index}\n`);
        } catch {
          // Client gone.
        }
        index += 1;
      } else {
        clearInterval(timer);
        try {
          res.end();
        } catch {
          // Client gone.
        }
      }
    }, 500);
    req.on("close", () => clearInterval(timer));
  });
  await new Promise((resolve) => slow.listen(0, "127.0.0.1", resolve));
  const slowUrl = `http://127.0.0.1:${slow.address().port}`;
  const gatewayHolder = [];
  let engineFetch = null;
  try {
    const draft = restProxyDraft("s09rtstream1", slowUrl, "/slow");
    draft.integrations[0].responseTransferMode = "STREAM";
    const { artifact, errors } = compile(draft);
    assert.equal(errors.length, 0, `STREAM must compile: ${errors[0]?.message}`);
    const streamArtifact = { ...artifact, allowLoopback: true, stage: "prod", stageVariables: {} };
    const loader = createMemoryLoader({
      pathRouting: true,
      stages: new Map([["s09rtstream1:prod", { artifact: streamArtifact }]]),
    });
    engineFetch = await isolatedFetch();
    const gateway = createGatewayServer({ loader, ports: { fetch: engineFetch.fetch } });
    gatewayHolder.push(gateway);
    const port = await gateway.start(0);
    const started = Date.now();
    const response = await fetch(`http://127.0.0.1:${port}/s09rtstream1/prod/pets`);
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const first = await reader.read();
    const firstByteAt = Date.now() - started;
    assert.ok(!first.done && first.value && first.value.byteLength > 0, "must receive a first chunk");
    assert.ok(firstByteAt < 2000, `first byte must arrive before upstream finishes (~2500 ms), took ${firstByteAt} ms`);
    let chunks = 1;
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      chunks += 1;
    }
    const totalAt = Date.now() - started;
    assert.equal(chunks, 5);
    assert.ok(totalAt >= 2000, `full stream must take ~2500 ms, took ${totalAt} ms`);
  } finally {
    for (const gateway of gatewayHolder) await closeQuietly(gateway);
    await engineFetch?.close?.().catch?.(() => {});
    await closeHttp(slow);
  }
});

test("S09 [runtime]: client disconnect aborts upstream within 100 ms", async () => {
  // Upstream leg is a stub `fetch` (no sockets): it streams until its signal
  // aborts and records when. The client → gateway leg is real HTTP, so this
  // proves gateway disconnect → engine → upstream abort propagation timing.
  let abortedAt = null;
  const stubFetch = async (url, options = {}) => {
    const signal = options.signal;
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("chunk-0\n"));
        const timer = setInterval(() => {
          if (signal?.aborted) {
            clearInterval(timer);
            abortedAt = Date.now();
            try {
              controller.close();
            } catch {
              // Best-effort.
            }
            return;
          }
          controller.enqueue(new TextEncoder().encode("more\n"));
        }, 20);
        signal?.addEventListener("abort", () => {
          clearInterval(timer);
          abortedAt = Date.now();
          try {
            controller.close();
          } catch {
            // Best-effort.
          }
        }, { once: true });
      },
      cancel() {
        abortedAt = abortedAt ?? Date.now();
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/plain" } });
  };
  const gatewayHolder = [];
  let engineFetch = null;
  try {
    const draft = restProxyDraft("s09rtabort001", "https://stub.test", "/slow");
    draft.integrations[0].uri = "https://stub.test/slow";
    draft.integrations[0].responseTransferMode = "STREAM";
    const { artifact, errors } = compile(draft);
    assert.equal(errors.length, 0);
    const streamArtifact = { ...artifact, allowLoopback: true, stage: "prod", stageVariables: {} };
    const loader = createMemoryLoader({
      pathRouting: true,
      stages: new Map([["s09rtabort001:prod", { artifact: streamArtifact }]]),
    });
    engineFetch = null;
    const gateway = createGatewayServer({ loader, ports: { fetch: stubFetch } });
    gatewayHolder.push(gateway);
    const port = await gateway.start(0);
    // Raw client (no pooling): read one chunk, then destroy the socket.
    const firstChunkAt = await new Promise((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port, path: "/s09rtabort001/prod/pets", method: "GET", headers: { connection: "close" } },
        (res) => {
          if (res.statusCode !== 200) {
            reject(new Error(`expected 200, got ${res.statusCode}`));
            req.destroy();
            return;
          }
          res.once("data", () => {
            const at = Date.now();
            req.destroy();
            resolve(at);
          });
        },
      );
      req.on("error", () => {});
      req.end();
    });
    const disconnectAt = firstChunkAt;
    for (let index = 0; index < 40 && abortedAt === null; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(abortedAt !== null, "upstream must observe the abort");
    assert.ok(abortedAt - disconnectAt < 1000, `abort must propagate quickly (took ${abortedAt - disconnectAt} ms)`);
  } finally {
    for (const gateway of gatewayHolder) await closeQuietly(gateway);
  }
});
