/**
 * S11C acceptance: disable_default_endpoint + private APIs.
 */

import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { compile } from "../../lib/gateway/artifact/compile.mjs";
import { handle } from "../../lib/gateway/core/index.mjs";
import { createMemoryLoader } from "../../gateway/loader.mjs";
import { createGatewayServer } from "../../gateway/server.mjs";
import { startUpstream } from "../fixtures/upstream.mjs";

process.env.PODS_ALLOW_LOOPBACK = "1";

/**
 * GETs a path with a real `Host` header. Undici `fetch` drops the forbidden
 * `host` header, so custom-domain routing must be exercised over `node:http`.
 *
 * @param {number} port
 * @param {string} path
 * @param {string} host
 */
function getWithHost(port, path, host) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: "127.0.0.1", port, path, method: "GET", headers: { host } },
      (response) => {
        let body = "";
        response.on("data", (chunk) => { body += chunk; });
        response.on("end", () => resolve({ status: response.statusCode, body }));
      },
    );
    request.once("error", reject);
    request.end();
  });
}

function restArtifact(upstreamUrl, { apiPublicId = "r1r2r3r4r5", edge = {}, settings = {} } = {}) {
  const draft = {
    projectId: "proj-1",
    apiId: "api-rest",
    apiPublicId,
    protocol: "REST",
    settings,
    resources: [{ id: "res-root", path: "/" }, { id: "res-pets", path: "/pets" }],
    methods: [{
      id: "m1", resourceId: "res-pets", httpMethod: "GET",
      authorizationType: "NONE", integrationId: "int1",
    }],
    integrations: [{ id: "int1", type: "HTTP_PROXY", uri: `${upstreamUrl}/echo`, timeoutMs: 5000 }],
    edge,
  };
  const { artifact, errors } = compile(draft);
  assert.equal(errors.length, 0);
  return { ...artifact, allowLoopback: true };
}

test("S11C: disable_default_endpoint → default host 403, custom domain 200", async () => {
  const upstream = await startUpstream();
  try {
    const artifact = restArtifact(upstream.url, {
      edge: { disableDefaultEndpoint: true },
    });
    assert.equal(artifact.edge.disableDefaultEndpoint, true);
    const stages = new Map([[`${artifact.apiPublicId}:prod`, { artifact }]]);
    const loader = createMemoryLoader({
      pathRouting: true,
      stages,
      customDomains: [{
        domainName: "api.example.com",
        status: "AVAILABLE",
        routingMode: "API_MAPPING_ONLY",
        mappings: [{ apiPublicId: artifact.apiPublicId, stage: "prod", basePath: "" }],
        rules: [],
      }],
    });
    const gateway = createGatewayServer({ loader });
    const port = await gateway.start(0);
    try {
      const viaDefault = await fetch(`http://127.0.0.1:${port}/${artifact.apiPublicId}/prod/pets`);
      assert.equal(viaDefault.status, 403);
      assert.deepEqual(await viaDefault.json(), { message: "Forbidden" });

      const viaCustom = await getWithHost(port, "/pets", "api.example.com");
      assert.equal(viaCustom.status, 200);
    } finally {
      await gateway.close();
    }
  } finally {
    await upstream.close();
  }
});

test("S11C [runtime]: private API reachable via connector ingress with allowing policy; direct request 403; private API without policy fails compile", async () => {
  const upstream = await startUpstream();
  try {
    // Compile refuses a private REST API without a resource policy.
    const { errors } = compile({
      projectId: "proj-1",
      apiId: "api-private",
      apiPublicId: "priv123456",
      protocol: "REST",
      resources: [{ id: "res-root", path: "/" }],
      methods: [{
        id: "m1", resourceId: "res-root", httpMethod: "GET",
        authorizationType: "NONE", integrationId: "int1",
      }],
      integrations: [{ id: "int1", type: "MOCK", uri: null, timeoutMs: 5000 }],
      edge: { endpointType: "PRIVATE" },
    });
    assert.ok(errors.length > 0, "expected a compile error for policy-less private API");
    assert.match(errors.map((entry) => entry.message).join(" "), /resource policy/i);

    const policy = {
      Version: "2012-10-17",
      Statement: [{
        Effect: "Allow",
        Principal: "*",
        Action: "execute-api:Invoke",
        Resource: "execute-api:/*",
        Condition: { StringEquals: { "aws:SourceVpce": "vpce-conn-1" } },
      }],
    };
    const artifact = restArtifact(upstream.url, {
      apiPublicId: "priv654321",
      edge: { endpointType: "PRIVATE" },
      // The resource policy lives in `settings` (S07 contract, persisted on
      // `pods.apis.resource_policy` and snapshotted by compile) — not under
      // `edge`, which compile never reads for policies.
      settings: { resourcePolicy: policy },
    });
    const stages = new Map([[`${artifact.apiPublicId}:prod`, { artifact }]]);
    const loader = createMemoryLoader({ pathRouting: true, stages });
    const gateway = createGatewayServer({
      loader,
      ports: { allowTestIngress: true },
    });
    const port = await gateway.start(0);
    try {
      // Direct request (no ingress) → 403.
      const direct = await fetch(`http://127.0.0.1:${port}/${artifact.apiPublicId}/prod/pets`);
      assert.equal(direct.status, 403);

      // Via connector ingress with an allowing policy → 200.
      const ingress = await fetch(`http://127.0.0.1:${port}/${artifact.apiPublicId}/prod/pets`, {
        headers: { "x-pods-test-ingress": "vpce-conn-1" },
      });
      assert.equal(ingress.status, 200);
    } finally {
      await gateway.close();
    }
  } finally {
    await upstream.close();
  }

  // Engine unit: the private flag also fails closed without ingress.
  const policy = {
    Version: "2012-10-17",
    Statement: [{
      Effect: "Allow", Principal: "*", Action: "execute-api:Invoke", Resource: "execute-api:/*",
      Condition: { StringEquals: { "aws:SourceVpce": "vpce-conn-1" } },
    }],
  };
  const artifact = restArtifact("http://127.0.0.1:1", { edge: { endpointType: "PRIVATE" }, settings: { resourcePolicy: policy } });
  const denied = await handle(new Request("http://gw.test/priv654321/prod/pets"), artifact, {});
  assert.equal(denied.status, 403);
});
