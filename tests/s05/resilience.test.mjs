import assert from "node:assert/strict";
import test from "node:test";
import { compile } from "../../lib/gateway/artifact/compile.mjs";
import { createMemoryLoader, createSupabaseLoader } from "../../gateway/loader.mjs";
import { createGatewayServer } from "../../gateway/server.mjs";
import { MemoryKvStore } from "../../lib/gateway/state/memory-kv.mjs";
import { startUpstream } from "../fixtures/upstream.mjs";

process.env.PODS_ALLOW_LOOPBACK = "1";

function artifactFor(upstreamUrl, apiPublicId = "r1r2r3r4r5") {
  const draft = {
    projectId: "proj-1", apiId: "api-1", apiPublicId, protocol: "HTTP",
    routes: [{ id: "r1", routeKey: "$default", integrationId: "int1" }],
    integrations: [{ id: "int1", type: "HTTP_PROXY", uri: `${upstreamUrl}/echo`, timeoutMs: 5000 }],
  };
  const { artifact, errors } = compile(draft);
  assert.equal(errors.length, 0);
  return { ...artifact, allowLoopback: true };
}

async function startSlowBackend(delayMs) {
  const http = await import("node:http");
  const server = http.createServer(async (req, res) => {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ method: req.method, path: req.url }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function fakeSupabaseClient({ apiPublicId, protocol = "HTTP", artifact, down = null, counts = null }) {
  return {
    schema() {
      return {
        from(table) {
          const filters = {};
          const chain = {
            select() { return chain; },
            eq(col, val) { filters[col] = val; return chain; },
            is() { return chain; },
            async maybeSingle() {
              if (down?.value) throw new Error("fetch failed: store outage");
              if (counts) counts[table] = (counts[table] ?? 0) + 1;
              if (table === "apis") {
                if (filters.public_id === apiPublicId) {
                  return { data: { id: "api-1", public_id: apiPublicId, protocol }, error: null };
                }
                return { data: null, error: null };
              }
              if (table === "stages") {
                if (filters.name === "$default") {
                  return { data: { id: "stage-1", api_id: "api-1", name: "$default", deployment_id: "dep-1", variables: {} }, error: null };
                }
                return { data: null, error: null };
              }
              if (table === "deployments") return { data: { id: "dep-1", artifact }, error: null };
              return { data: null, error: null };
            },
          };
          return chain;
        },
      };
    },
  };
}

function fakeSupabaseWithStages({ protocol = "REST", artifact, counts = null }) {
  return {
    schema() {
      return {
        from(table) {
          const filters = {};
          const chain = {
            select() { return chain; },
            eq(col, val) { filters[col] = val; return chain; },
            is() { return chain; },
            async maybeSingle() {
              if (counts) counts[table] = (counts[table] ?? 0) + 1;
              if (table === "apis") {
                return { data: { id: "api-1", public_id: "host123456", protocol }, error: null };
              }
              if (table === "stages") {
                if (filters.name === "prod") {
                  return { data: { id: "s1", api_id: "api-1", name: "prod", deployment_id: "dep-1", variables: {} }, error: null };
                }
                if (filters.name === "$default") return { data: null, error: null };
                return { data: null, error: null };
              }
              return { data: { id: "dep-1", artifact }, error: null };
            },
          };
          return chain;
        },
      };
    },
  };
}

test("S05 [runtime]: store outage keeps serving cached artifact; graceful shutdown drains an in-flight slow request", async () => {
  const upstream = await startUpstream();
  try {
    const apiPublicId = "outage1234";
    const artifact = artifactFor(upstream.url, apiPublicId);
    const down = { value: false };
    const fakeSupabase = fakeSupabaseClient({ apiPublicId, artifact, down });
    const loader = createSupabaseLoader({ supabase: fakeSupabase, kv: new MemoryKvStore({}) });
    const first = await loader.resolve("localhost", `/${apiPublicId}/items`);
    assert.equal(first.stage, "$default");
    down.value = true;
    const gateway = createGatewayServer({ loader });
    const port = await gateway.start(0);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/${apiPublicId}/items`);
      assert.equal(response.status, 200);
    } finally {
      await gateway.close();
    }

    // Graceful shutdown drains an in-flight slow request (inline slow backend;
    // the shared fixture's /sleep path is S04-owned, so this test owns its
    // own 800 ms server).
    const slowBackend = await startSlowBackend(800);
    try {
      const slowDraft = {
        projectId: "proj-1", apiId: "api-1", apiPublicId: "slow123456", protocol: "HTTP",
        routes: [{ id: "r1", routeKey: "$default", integrationId: "int1" }],
        integrations: [{ id: "int1", type: "HTTP_PROXY", uri: `${slowBackend.url}/echo`, timeoutMs: 5000 }],
      };
      const { artifact: slowBase, errors: slowErrors } = compile(slowDraft);
      assert.equal(slowErrors.length, 0);
      const slowArtifact = { ...slowBase, allowLoopback: true };
      const slowLoader = createMemoryLoader({
        pathRouting: true,
        stages: new Map([[`slow123456:$default`, { artifact: slowArtifact }]]),
      });
      const slowGateway = createGatewayServer({ loader: slowLoader });
      const slowPort = await slowGateway.start(0);
      const pending = fetch(`http://127.0.0.1:${slowPort}/slow123456/items`);
      await new Promise((resolve) => setTimeout(resolve, 200));
      const closed = slowGateway.close({ timeoutMs: 10000 });
      const slowResponse = await pending;
      assert.equal(slowResponse.status, 200);
      await closed;
    } finally {
      await slowBackend.close();
    }
  } finally {
    await upstream.close();
  }
});

test("S05: loader resolve covers host-based, path-based and negative cache", async () => {
  const artifact = artifactFor("http://127.0.0.1:9", "host123456");
  const loader = createMemoryLoader({
    domain: "gw.geigerpods.app",
    stages: new Map([[`host123456:prod`, { artifact }]]),
  });
  const hostBased = await loader.resolve("host123456.gw.geigerpods.app", "/prod/pets");
  assert.equal(hostBased.stage, "prod");
  assert.equal(hostBased.basePathStripped, "/pets");
  const pathBased = await createMemoryLoader({
    pathRouting: true,
    stages: new Map([[`host123456:prod`, { artifact }]]),
  }).resolve("localhost", "/host123456/prod/pets");
  assert.equal(pathBased.basePathStripped, "/pets");

  const counts = {};
  const kv = new MemoryKvStore({});
  const fakeSupabase = fakeSupabaseWithStages({ artifact, counts });
  const supaLoader = createSupabaseLoader({ supabase: fakeSupabase, kv });
  await supaLoader.resolve("localhost", "/host123456/prod/pets");
  const stagesAfterFirst = counts.stages ?? 0;
  const deploymentsAfterFirst = counts.deployments ?? 0;
  await supaLoader.resolve("localhost", "/host123456/prod/pets");
  assert.equal(counts.stages ?? 0, stagesAfterFirst, "second resolve should hit the stage cache");
  assert.equal(counts.deployments ?? 0, deploymentsAfterFirst, "second resolve should hit the artifact cache");
});
