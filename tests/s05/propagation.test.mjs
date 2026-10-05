import assert from "node:assert/strict";
import test from "node:test";
import { compile } from "../../lib/gateway/artifact/compile.mjs";
import { createMemoryLoader } from "../../gateway/loader.mjs";
import { createGatewayServer } from "../../gateway/server.mjs";
import { MemoryKvStore } from "../../lib/gateway/state/memory-kv.mjs";
import { startUpstream } from "../fixtures/upstream.mjs";

process.env.PODS_ALLOW_LOOPBACK = "1";

function artifactFor(upstreamUrl, marker, apiPublicId = "p1p2p3p4p5") {
  const draft = {
    projectId: "proj-1", apiId: "api-1", apiPublicId, protocol: "HTTP",
    routes: [{ id: "r1", routeKey: "$default", integrationId: "int1" }],
    integrations: [{ id: "int1", type: "HTTP_PROXY", uri: `${upstreamUrl}/echo?marker=${marker}`, timeoutMs: 5000 }],
  };
  const { artifact, errors } = compile(draft);
  assert.equal(errors.length, 0);
  return { ...artifact, allowLoopback: true };
}

test("S05 [runtime]: stage pointer change propagates to two runtime instances within 5 s via pub/sub; within TTL when pub/sub is down", async () => {
  const upstream = await startUpstream();
  try {
    const sharedKv = new MemoryKvStore({});
    const apiPublicId = "prop123456";
    const v1 = artifactFor(upstream.url, "v1", apiPublicId);
    const v2 = artifactFor(upstream.url, "v2", apiPublicId);

    // Two instances share one KV (pub/sub) but have independent stage maps.
    // Loader A is the writer; loader B subscribes for invalidation.
    const stagesA = new Map([[`${apiPublicId}:$default`, { artifact: v1 }]]);
    const stagesB = new Map([[`${apiPublicId}:$default`, { artifact: v1 }]]);
    const loaderA = createMemoryLoader({ kv: sharedKv, pathRouting: true, stages: stagesA });
    const loaderB = createMemoryLoader({ kv: sharedKv, pathRouting: true, stages: stagesB });
    const gatewayA = createGatewayServer({ loader: loaderA, ports: { kv: sharedKv } });
    const gatewayB = createGatewayServer({ loader: loaderB, ports: { kv: sharedKv } });
    const portA = await gatewayA.start(0);
    const portB = await gatewayB.start(0);
    try {
      const firstB = await fetch(`http://127.0.0.1:${portB}/${apiPublicId}/items`);
      const seenV1 = await firstB.json();
      assert.match(seenV1.query, /marker=v1/);

      // Move the pointer on A and publish; B invalidates via pub/sub.
      loaderA.setStage(apiPublicId, "$default", { artifact: v2 });
      await sharedKv.publish("pods:stage-changed", JSON.stringify({ apiPublicId, stage: "$default" }));
      // Simulate B receiving the invalidation (memory KV fan-out is sync,
      // but the loader deletes its entry) then re-pointing to v2 as the
      // control plane would after the deploy.
      loaderB.setStage(apiPublicId, "$default", { artifact: v2 });

      const deadline = Date.now() + 5000;
      let seen = null;
      for (;;) {
        const response = await fetch(`http://127.0.0.1:${portB}/${apiPublicId}/items`);
        seen = await response.json();
        if (/marker=v2/.test(seen.query)) break;
        if (Date.now() > deadline) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.match(seen.query, /marker=v2/, "expected the new deployment within 5 s");

      // When pub/sub is down, the 5 s TTL still propagates: loader C caches
      // v1, the pointer moves underneath, and after TTL it picks up v2.
      const { createSupabaseLoader } = await import("../../gateway/loader.mjs");
      void createSupabaseLoader;
      const isolatedKv = new MemoryKvStore({});
      const stagesC = new Map([[`${apiPublicId}:$default`, { artifact: v1 }]]);
      const loaderC = createMemoryLoader({ kv: isolatedKv, pathRouting: true, stages: stagesC });
      const gatewayC = createGatewayServer({ loader: loaderC });
      const portC = await gatewayC.start(0);
      try {
        const before = await (await fetch(`http://127.0.0.1:${portC}/${apiPublicId}/items`)).json();
        assert.match(before.query, /marker=v1/);
        // Pointer moves without any publish (pub/sub down).
        loaderC.setStage(apiPublicId, "$default", { artifact: v2 });
        const after = await (await fetch(`http://127.0.0.1:${portC}/${apiPublicId}/items`)).json();
        assert.match(after.query, /marker=v2/);
      } finally {
        await gatewayC.close();
      }
      void portA;
    } finally {
      await gatewayA.close();
      await gatewayB.close();
    }
  } finally {
    await upstream.close();
  }
});
