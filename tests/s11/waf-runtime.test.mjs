/**
 * S11D [runtime]: blocked request → 403 WAF_FILTERED, access-log waf fields,
 * sampled request recorded.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { compile } from "../../lib/gateway/artifact/compile.mjs";
import { handle } from "../../lib/gateway/core/index.mjs";
import { createMemoryLoader } from "../../gateway/loader.mjs";
import { createGatewayServer } from "../../gateway/server.mjs";
import { MemoryKvStore } from "../../lib/gateway/state/memory-kv.mjs";
import { getSampledRequests } from "../../lib/gateway/core/edge/waf-engine.mjs";
import { startUpstream } from "../fixtures/upstream.mjs";

process.env.PODS_ALLOW_LOOPBACK = "1";

function wafArtifact(upstreamUrl, { acl }) {
  const draft = {
    projectId: "proj-1",
    apiId: "api-waf",
    apiPublicId: "waf1234567",
    protocol: "REST",
    resources: [{ id: "res-root", path: "/" }, { id: "res-pets", path: "/pets" }],
    methods: [{
      id: "m1", resourceId: "res-pets", httpMethod: "GET",
      authorizationType: "NONE", integrationId: "int1",
    }],
    integrations: [{ id: "int1", type: "HTTP_PROXY", uri: `${upstreamUrl}/echo`, timeoutMs: 5000 }],
    edge: {
      waf: {
        webAclArn: "pods://waf/acls/acl-1",
        acl: {
          name: "acl-1",
          defaultAction: "ALLOW",
          rules: acl?.rules ?? [{
            name: "block-bad",
            priority: 1,
            action: "BLOCK",
            statement: {
              type: "ByteMatchStatement",
              fieldToMatch: { SingleHeader: { name: "x-attack" } },
              positionalConstraint: "EXACTLY",
              searchString: "true",
              textTransformations: ["NONE"],
            },
          }],
          visibility: { sampledRequests: true, metrics: true },
        },
        ipSets: {},
        regexSets: {},
      },
    },
  };
  const { artifact, errors } = compile(draft);
  assert.equal(errors.length, 0);
  return { ...artifact, allowLoopback: true };
}

test("S11D: blocked request → 403 WAF_FILTERED and access-log waf fields; sampled request recorded", async () => {
  const upstream = await startUpstream();
  try {
    const kv = new MemoryKvStore({});
    const events = [];
    const artifact = wafArtifact(upstream.url, {});
    const loader = createMemoryLoader({
      pathRouting: true,
      stages: new Map([[`${artifact.apiPublicId}:prod`, { artifact }]]),
    });
    const gateway = createGatewayServer({
      loader,
      ports: { kv, events: { emit: (event) => events.push(event) } },
    });
    const port = await gateway.start(0);
    try {
      const blocked = await fetch(`http://127.0.0.1:${port}/${artifact.apiPublicId}/prod/pets`, {
        headers: { "x-attack": "true" },
      });
      assert.equal(blocked.status, 403);
      assert.equal(blocked.headers.get("x-pods-error-type"), "WAF_FILTERED");
      assert.deepEqual(await blocked.json(), { message: "Forbidden" });

      const allowed = await fetch(`http://127.0.0.1:${port}/${artifact.apiPublicId}/prod/pets`);
      assert.equal(allowed.status, 200);

      // The emit phase fans out off the response path; wait for delivery.
      for (let attempt = 0; attempt < 50 && !events.some((event) => event?.wafAction === "BLOCK"); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      // The engine records the block in the access-log event.
      const blockedEvent = events.find((event) => event?.wafAction === "BLOCK");
      assert.ok(blockedEvent, "expected an access-log event with waf fields");
      assert.equal(blockedEvent.wafAction, "BLOCK");

      // Sampled requests keep the blocked request for the rule/stage.
      const samples = await getSampledRequests(kv, { aclId: "acl-1", stage: "prod", ruleName: "block-bad" });
      assert.ok(samples.length >= 1, "expected at least one sampled request");
      assert.equal(samples[0].action, "BLOCK");
    } finally {
      await gateway.close();
    }
  } finally {
    await upstream.close();
  }

  // Engine unit: the same ACL sets $context.waf.* on the context.
  const kv = new MemoryKvStore({});
  const artifact = wafArtifact("http://127.0.0.1:1", {});
  const { buildContext, runPipeline } = await import("../../lib/gateway/core/index.mjs");
  const ports = (await import("../../lib/gateway/core/index.mjs")).createPorts({ kv });
  const ctx = buildContext(
    new Request("http://gw.test/pets", { headers: { "x-attack": "true" } }),
    artifact,
    ports,
  );
  ctx.requestPath = "/pets";
  ctx.basePathStripped = "/pets";
  ctx.stage = "prod";
  const response = await runPipeline(ctx);
  assert.equal(response.status, 403);
  assert.equal(ctx.context.wafResponseCode, "WAF_BLOCK");
  assert.equal(ctx.context.webaclArn, "pods://waf/acls/acl-1");
  assert.ok(Number(ctx.context.waf.latency) >= 0);
  void handle;
});
