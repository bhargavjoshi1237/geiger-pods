/**
 * S09 bullet 13: idle timeout closes the stream; bandwidth caps past 10 MB.
 */

import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { compile } from "../../lib/gateway/artifact/compile.mjs";
import { ByteLimiter } from "../../lib/gateway/core/release/streaming.mjs";
import { createMemoryLoader } from "../../gateway/loader.mjs";
import { createGatewayServer } from "../../gateway/server.mjs";

process.env.PODS_ALLOW_LOOPBACK = "1";

/**
 * Closes a gateway even with pooled keep-alive connections.
 *
 * @param {object} target
 */
async function closeQuietly(target) {
  try {
    target?.server?.closeAllConnections?.();
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
async function closeHttp(server) {
  try {
    server?.closeAllConnections?.();
  } catch {
    // Best-effort.
  }
  await new Promise((resolve) => server.close(resolve));
}

test("S09 [runtime]: stream idle > configured idle timeout is closed; stream beyond 10 MB is rate-capped (injected clock)", async () => {
  // Part 1 (runtime): upstream sends one chunk then stalls; the stream must
  // close after the configured idle timeout instead of hanging to 15 min.
  const stalled = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/plain", "transfer-encoding": "chunked" });
    res.write("chunk-0\n");
    const timer = setTimeout(() => {
      try {
        res.end();
      } catch {
        // Client gone.
      }
    }, 10000);
    req.on("close", () => clearTimeout(timer));
  });
  await new Promise((resolve) => stalled.listen(0, "127.0.0.1", resolve));
  const stalledUrl = `http://127.0.0.1:${stalled.address().port}`;
  const gatewayHolder = [];
  try {
    const draft = {
      projectId: "proj-s09",
      apiId: "api-s09-idle",
      apiPublicId: "s09rtidle0001",
      protocol: "REST",
      resources: [{ id: "res-root", path: "/" }, { id: "res-pets", path: "/pets" }],
      methods: [{
        id: "m1", resourceId: "res-pets", httpMethod: "GET",
        authorizationType: "NONE", authorizerId: null, authorizationScopes: [],
        apiKeyRequired: false, requestValidatorId: null, requestParameters: {},
        requestModels: {}, integrationId: "int-1",
      }],
      integrations: [{ id: "int-1", type: "HTTP_PROXY", uri: `${stalledUrl}/stall`, timeoutMs: 5000, responseTransferMode: "STREAM" }],
      features: { streamIdleTimeoutMs: 300 },
    };
    const { artifact, errors } = compile(draft);
    assert.equal(errors.length, 0);
    const streamArtifact = { ...artifact, allowLoopback: true, stage: "prod", stageVariables: {} };
    const loader = createMemoryLoader({
      pathRouting: true,
      stages: new Map([["s09rtidle0001:prod", { artifact: streamArtifact }]]),
    });
    const gateway = createGatewayServer({ loader });
    gatewayHolder.push(gateway);
    const port = await gateway.start(0);
    const started = Date.now();
    const response = await fetch(`http://127.0.0.1:${port}/s09rtidle0001/prod/pets`);
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    let chunks = 0;
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      chunks += 1;
    }
    const elapsed = Date.now() - started;
    assert.equal(chunks, 1, "must receive the pre-idle chunk");
    assert.ok(elapsed < 5000, `idle timeout must close the stream (took ${elapsed} ms, upstream stalls 10 s)`);
  } finally {
    for (const gateway of gatewayHolder) await closeQuietly(gateway);
    await closeHttp(stalled);
  }

  // Part 2 (injected clock): past 10 MB the limiter caps throughput.
  let now = 0;
  const limiter = new ByteLimiter({ capBytesPerSec: 2 * 1024 * 1024, clock: { now: () => now } });
  assert.equal(limiter.take(10 * 1024 * 1024, now), 0, "first 10 MB unthrottled");
  assert.equal(limiter.take(4 * 1024 * 1024, now), 1000, "4 MB past the cap with a 2 MB burst waits 1000 ms");
});
