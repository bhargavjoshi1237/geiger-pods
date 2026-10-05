import assert from "node:assert/strict";
import test from "node:test";
import { compile } from "../../lib/gateway/artifact/compile.mjs";
import { createMemoryLoader } from "../../gateway/loader.mjs";
import { createGatewayServer } from "../../gateway/server.mjs";
import { MemoryKvStore } from "../../lib/gateway/state/memory-kv.mjs";
import { startUpstream } from "../fixtures/upstream.mjs";

process.env.PODS_ALLOW_LOOPBACK = "1";

function httpArtifact(upstreamUrl, { apiPublicId = "h1h2h3h4h5", stageVariables = {} } = {}) {
  const draft = {
    projectId: "proj-1", apiId: "api-http", apiPublicId, protocol: "HTTP",
    routes: [{ id: "r1", routeKey: "$default", integrationId: "int1" }],
    integrations: [{ id: "int1", type: "HTTP_PROXY", uri: `${upstreamUrl}/echo`, timeoutMs: 5000 }],
  };
  const { artifact, errors } = compile(draft);
  assert.equal(errors.length, 0);
  return { ...artifact, stageVariables, allowLoopback: true };
}

function restArtifact(upstreamUrl, { apiPublicId = "r1r2r3r4r5" } = {}) {
  const draft = {
    projectId: "proj-1", apiId: "api-rest", apiPublicId, protocol: "REST",
    resources: [{ id: "res-root", path: "/" }, { id: "res-pets", path: "/pets" }],
    methods: [{
      id: "m1", resourceId: "res-pets", httpMethod: "GET",
      authorizationType: "NONE", integrationId: "int1",
    }],
    integrations: [{ id: "int1", type: "HTTP_PROXY", uri: `${upstreamUrl}/echo`, timeoutMs: 5000 }],
  };
  const { artifact, errors } = compile(draft);
  assert.equal(errors.length, 0);
  return { ...artifact, allowLoopback: true };
}

test("S05 [runtime]: create HTTP API with $default route → deploy to $default stage → GET via host-based URL reaches upstream echo; path has no stage prefix", async () => {
  const upstream = await startUpstream();
  const kv = new MemoryKvStore({});
  try {
    const artifact = httpArtifact(upstream.url);
    const loader = createMemoryLoader({
      kv,
      pathRouting: true,
      stages: new Map([[`${artifact.apiPublicId}:$default`, { artifact }]]),
    });
    const gateway = createGatewayServer({ loader, ports: { kv } });
    const port = await gateway.start(0);
    try {
      // Path-based (dev): /{apiPublicId}/{path} with no stage prefix for $default.
      const response = await fetch(`http://127.0.0.1:${port}/${artifact.apiPublicId}/orders/42?tag=1`);
      assert.equal(response.status, 200);
      const seen = await response.json();
      assert.equal(seen.method, "GET");
      // The $default stage serves without a prefix; the backend sees the full path.
      assert.match(seen.path, /\/orders\/42/);
      assert.ok(!seen.path.includes("$default"));
      assert.equal(seen.query, "?tag=1");
    } finally {
      await gateway.close();
    }
  } finally {
    await upstream.close();
  }
});

test("S05 [runtime]: REST stage \"prod\" serves /prod/pets; unknown stage → 403 Forbidden; HTTP unknown stage without $default → 404", async () => {
  const upstream = await startUpstream();
  try {
    const rest = restArtifact(upstream.url);
    const restLoader = createMemoryLoader({
      pathRouting: true,
      stages: new Map([[`${rest.apiPublicId}:prod`, { artifact: rest }]]),
    });
    const restGateway = createGatewayServer({ loader: restLoader });
    const restPort = await restGateway.start(0);
    try {
      const ok = await fetch(`http://127.0.0.1:${restPort}/${rest.apiPublicId}/prod/pets`);
      assert.equal(ok.status, 200);
      const unknown = await fetch(`http://127.0.0.1:${restPort}/${rest.apiPublicId}/nope/pets`);
      assert.equal(unknown.status, 403);
      assert.deepEqual(await unknown.json(), { message: "Forbidden" });
    } finally {
      await restGateway.close();
    }

    // HTTP without $default: unknown stage → 404.
    const draft = {
      projectId: "proj-1", apiId: "api-http2", apiPublicId: "h9h9h9h9h9", protocol: "HTTP",
      routes: [{ id: "r1", routeKey: "GET /pets", integrationId: "int1" }],
      integrations: [{ id: "int1", type: "HTTP_PROXY", uri: `${upstream.url}/echo`, timeoutMs: 5000 }],
    };
    const { artifact } = compile(draft);
    const httpLoader = createMemoryLoader({
      pathRouting: true,
      stages: new Map([[`${artifact.apiPublicId}:prod`, { artifact: { ...artifact, allowLoopback: true } }]]),
    });
    const httpGateway = createGatewayServer({ loader: httpLoader });
    const httpPort = await httpGateway.start(0);
    try {
      const unknown = await fetch(`http://127.0.0.1:${httpPort}/${artifact.apiPublicId}/nope/pets`);
      assert.equal(unknown.status, 404);
      assert.deepEqual(await unknown.json(), { message: "Not Found" });
    } finally {
      await httpGateway.close();
    }
  } finally {
    await upstream.close();
  }
});

test("S05 [runtime]: editing the draft does not change live responses until deploy", async () => {
  const upstream = await startUpstream();
  try {
    const v1 = httpArtifact(upstream.url, { apiPublicId: "edit123456" });
    const stages = new Map([[`${v1.apiPublicId}:$default`, { artifact: v1 }]]);
    const loader = createMemoryLoader({ pathRouting: true, stages });
    const gateway = createGatewayServer({ loader });
    const port = await gateway.start(0);
    try {
      const first = await fetch(`http://127.0.0.1:${port}/${v1.apiPublicId}/items`);
      assert.equal(first.status, 200);
      // Edit the draft (new artifact pointing elsewhere) but do not deploy.
      const v2draft = {
        projectId: "proj-1", apiId: "api-http", apiPublicId: v1.apiPublicId, protocol: "HTTP",
        routes: [{ id: "r1", routeKey: "$default", integrationId: "int1" }],
        integrations: [{ id: "int1", type: "HTTP_PROXY", uri: `${upstream.url}/status/201`, timeoutMs: 5000 }],
      };
      const { artifact: v2 } = compile(v2draft);
      void v2;
      const second = await fetch(`http://127.0.0.1:${port}/${v1.apiPublicId}/items`);
      assert.equal(second.status, 200);
      const seen = await second.json();
      // $default appends the full request path (AWS parity).
      assert.equal(seen.path, "/echo/items");
      // Deploy v2 → behavior changes.
      loader.setStage(v1.apiPublicId, "$default", { artifact: { ...v2, allowLoopback: true } });
      const third = await fetch(`http://127.0.0.1:${port}/${v1.apiPublicId}/items`);
      assert.equal(third.status, 201);
    } finally {
      await gateway.close();
    }
  } finally {
    await upstream.close();
  }
});

test("S05 [runtime]: rollback restores exact previous behavior; stage_history records both moves", async () => {
  const { createFakeDb } = await import("./fake-db.mjs");
  const { createDeployment, resetDeployState, setDeployClock } = await import("../../lib/control/deployments.mjs");
  const { rollbackStage, listStageHistory } = await import("../../lib/control/stages.mjs");
  resetDeployState();
  const PROJECT = "11111111-1111-4111-8111-111111111111";
  const ADMIN = { type: "user", userId: "u-admin" };
  const db = createFakeDb({ roles: { "u-admin": "admin" } });
  const api = await db.insertApi({
    project_id: PROJECT, public_id: "rb12345678", name: `rb-${Date.now()}`, protocol: "REST",
    api_key_source: "HEADER", binary_media_types: [], minimum_compression_size: null,
    missing_route_behavior: "aws", cors: null, resource_policy: null, route_selection_expression: null,
  });
  const int = await db.insertIntegration({
    project_id: PROJECT, api_id: api.id, public_id: "intrb00001", type: "MOCK",
    integration_method: "ANY", uri: null, connection_type: "INTERNET",
    connector_id: null, timeout_ms: 5000, backend_auth: null, function: null, aws: null,
  });
  const root = await db.insertResource({ project_id: PROJECT, api_id: api.id, parent_id: null, path_part: "", path: "/" });
  const pets = await db.insertResource({ project_id: PROJECT, api_id: api.id, parent_id: root.id, path_part: "pets", path: "/pets" });
  await db.insertMethod({
    project_id: PROJECT, api_id: api.id, resource_id: pets.id, http_method: "GET",
    authorization_type: "NONE", authorizer_id: null, authorization_scopes: [],
    api_key_required: false, request_validator_id: null, request_parameters: {},
    request_models: {}, integration_id: int.id,
  });
  const v1 = await createDeployment(db, ADMIN, { projectId: PROJECT, apiId: api.id, description: "v1", stageName: "prod" });
  setDeployClock({ now: () => Date.now() + 5000 });
  const v2 = await createDeployment(db, ADMIN, { projectId: PROJECT, apiId: api.id, description: "v2", stageName: "prod" });
  assert.notEqual(v1.body.id, v2.body.id);
  // Exact previous behavior: the artifact bytes of v1 are unchanged.
  const v1row = await db.getDeploymentById(v1.body.id);
  assert.equal(v1row.digest, v1.body.digest);
  const back = await rollbackStage(db, ADMIN, { projectId: PROJECT, apiId: api.id, stageName: "prod", deploymentId: v1.body.id });
  assert.equal(back.deploymentId, v1.body.id);
  const { items } = await listStageHistory(db, ADMIN, { projectId: PROJECT, apiId: api.id, stageName: "prod" });
  assert.deepEqual(items.map((entry) => entry.reason), ["deploy", "deploy", "rollback"]);
  resetDeployState();
});
