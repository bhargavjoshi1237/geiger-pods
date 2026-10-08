/**
 * S09 stage cache [runtime] (S15 part 2): hits through the real gateway host.
 *
 * `tests/s09/cache.test.mjs` proves hit/miss semantics through the engine
 * (`handle()` + a real upstream). This file proves the same behavior through
 * `createGatewayServer` + the memory loader: the stage cache snapshot
 * travels `loader → resolved.stageCache → ctx.stageCache`, so the second
 * identical GET is served from cache and the upstream sees one request.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { compile } from "../../lib/gateway/artifact/compile.mjs";
import { createGatewayServer } from "../../gateway/server.mjs";
import { createMemoryLoader } from "../../gateway/loader.mjs";
import { MemoryKvStore } from "../../lib/gateway/state/memory-kv.mjs";
import { startUpstream } from "../fixtures/upstream.mjs";

process.env.PODS_ALLOW_LOOPBACK = "1";

function cachedArtifact(upstreamUrl) {
  const draft = {
    projectId: "proj-1",
    apiId: "api-cache-host",
    apiPublicId: "s09ch00001",
    protocol: "REST",
    resources: [
      { id: "res-root", path: "/" },
      { id: "res-pets", path: "/pets" },
    ],
    methods: [
      { id: "m-get", resourceId: "res-pets", httpMethod: "GET", authorizationType: "NONE", integrationId: "int-1" },
    ],
    integrations: [
      { id: "int-1", type: "HTTP_PROXY", uri: `${upstreamUrl}/echo`, timeoutMs: 5000 },
    ],
  };
  const { artifact, errors } = compile(draft);
  assert.equal(errors.length, 0, `fixture must compile: ${errors[0]?.message}`);
  return { ...artifact, allowLoopback: true };
}

test("S09 [runtime]: second identical GET is a cache hit through the real gateway", async (t) => {
  const upstream = await startUpstream();
  t.after(() => upstream.close());
  const artifact = cachedArtifact(upstream.url);
  const loader = createMemoryLoader({
    pathRouting: true,
    stages: new Map([[`${artifact.apiPublicId}:prod`, {
      artifact,
      stageCache: { enabled: true, size: "0.5", defaultTtl: 60 },
    }]]),
  });
  const gateway = createGatewayServer({
    loader,
    ports: { kv: new MemoryKvStore() },
  });
  const port = await gateway.start(0);
  t.after(() => gateway.close());
  const url = `http://127.0.0.1:${port}/${artifact.apiPublicId}/prod/pets`;

  const first = await fetch(url);
  assert.equal(first.status, 200);
  const firstBody = await first.text();
  const second = await fetch(url);
  assert.equal(second.status, 200);
  assert.equal(await second.text(), firstBody);
  assert.equal(upstream.requests.length, 1, "second GET must be served from stage cache");
});
