/**
 * S09 control-plane tests: canary/cache validation, permissions and the
 * integration S09 fields (transfer mode, cache key params).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createFakeDb } from "../s05/fake-db.mjs";
import { createDeployment, resetDeployState, setDeployClock } from "../../lib/control/deployments.mjs";
import { deleteCanary, deployToCanary, getCanary, putCanary } from "../../lib/control/canary.mjs";
import { flushStageCache, getStageCache, putStageCache } from "../../lib/control/stage-cache.mjs";

const PROJECT = "55555555-5555-4535-8355-555555555555";
const ADMIN = { type: "user", userId: "u-admin" };
const MEMBER = { type: "user", userId: "u-member" };

async function seedRestApi(db, publicId = "s09ctl000001") {
  const api = await db.insertApi({
    project_id: PROJECT, public_id: publicId, name: `s09-${publicId}`, protocol: "REST",
    api_key_source: "HEADER", binary_media_types: [], minimum_compression_size: null,
    missing_route_behavior: "aws", cors: null, resource_policy: null, route_selection_expression: null,
  });
  const int = await db.insertIntegration({
    project_id: PROJECT, api_id: api.id, public_id: "ints09ctl01", type: "MOCK",
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
  return api;
}

test("S09: canary rejects bad percent, HTTP APIs and missing deployments", async () => {
  resetDeployState();
  const db = createFakeDb({ roles: { "u-admin": "admin", "u-member": "member" } });
  const api = await seedRestApi(db);
  await createDeployment(db, ADMIN, { projectId: PROJECT, apiId: api.id, description: "v1", stageName: "prod" });
  await assert.rejects(
    putCanary(db, ADMIN, { projectId: PROJECT, apiId: api.id, stageName: "prod", input: { percentTraffic: 150 } }),
    /0–100/,
  );
  await assert.rejects(
    putCanary(db, ADMIN, { projectId: PROJECT, apiId: api.id, stageName: "prod", input: { percentTraffic: 10.55 } }),
    /one decimal/,
  );
  const deleted = await deleteCanary(db, ADMIN, { projectId: PROJECT, apiId: api.id, stageName: "prod" });
  assert.equal(deleted.deleted, true);
  assert.equal(await getCanary(db, ADMIN, { projectId: PROJECT, apiId: api.id, stageName: "prod" }), null);
  resetDeployState();
});

test("S09: stage cache validates size, TTL and strategy; member cannot flush", async () => {
  const db = createFakeDb({ roles: { "u-admin": "admin", "u-member": "member" } });
  const api = await seedRestApi(db, "s09ctl000002");
  await db.insertStage({ project_id: PROJECT, api_id: api.id, name: "prod", deployment_id: null, variables: {} });
  await assert.rejects(
    putStageCache(db, ADMIN, { projectId: PROJECT, apiId: api.id, stageName: "prod", input: { enabled: true } }),
    /requires a size/,
  );
  await assert.rejects(
    putStageCache(db, ADMIN, { projectId: PROJECT, apiId: api.id, stageName: "prod", input: { enabled: true, size: "99" } }),
    /must be one of/,
  );
  const cache = await putStageCache(db, ADMIN, {
    projectId: PROJECT, apiId: api.id, stageName: "prod",
    input: { enabled: true, size: "0.5", defaultTtl: 120, encrypted: true, methodSettings: { "/pets/GET": { cacheTtlInSeconds: 30 } } },
  });
  assert.equal(cache.enabled, true);
  assert.equal(cache.defaultTtl, 120);
  assert.deepEqual(await getStageCache(db, ADMIN, { projectId: PROJECT, apiId: api.id, stageName: "prod" }), cache);
  await assert.rejects(
    flushStageCache(db, MEMBER, { projectId: PROJECT, apiId: api.id, stageName: "prod" }),
    (error) => error?.status === 403,
  );
});

test("S09: integrations accept cache key params and STREAM transfer mode", async () => {
  const { createIntegration, updateIntegration } = await import("../../lib/control/integrations.mjs");
  const db = createFakeDb({ roles: { "u-admin": "admin" } });
  // The S05 fake has no integration row accessors; add minimal ones.
  db.getIntegrationById = async (id) => {
    const row = db._maps.integrations.get(id);
    return row ? { ...row } : null;
  };
  db.updateIntegration = async (id, patch) => {
    const row = db._maps.integrations.get(id);
    if (!row) throw new Error("missing");
    const next = { ...row, ...patch, version: (row.version ?? 1) + 1, updated_at: new Date().toISOString() };
    db._maps.integrations.set(id, next);
    return { ...next };
  };
  const api = await seedRestApi(db, "s09ctl000003");
  const created = await createIntegration(db, ADMIN, {
    projectId: PROJECT, apiId: api.id,
    input: {
      type: "HTTP_PROXY", uri: "https://backend.test/echo",
      cacheKeyParameters: ["method.request.querystring.page"],
      cacheNamespace: "v1",
      responseTransferMode: "BUFFERED",
    },
  });
  assert.deepEqual(created.body.cacheKeyParameters, ["method.request.querystring.page"]);
  assert.equal(created.body.cacheNamespace, "v1");
  await assert.rejects(
    createIntegration(db, ADMIN, {
      projectId: PROJECT, apiId: api.id,
      input: { type: "HTTP_PROXY", uri: "https://backend.test/echo", cacheKeyParameters: ["bogus"] },
    }),
    /cacheKeyParameters/,
  );
  const streamed = await updateIntegration(db, ADMIN, {
    projectId: PROJECT, apiId: api.id, integrationId: created.body.id,
    patch: { responseTransferMode: "STREAM" },
  });
  assert.equal(streamed.responseTransferMode, "STREAM");
});

test("S09: deploy-to-canary points only the canary at the new deployment", async () => {
  resetDeployState();
  const db = createFakeDb({ roles: { "u-admin": "admin" } });
  const api = await seedRestApi(db, "s09ctl000004");
  const v1 = await createDeployment(db, ADMIN, { projectId: PROJECT, apiId: api.id, description: "v1", stageName: "prod" });
  setDeployClock({ now: () => Date.now() + 5000 });
  const result = await deployToCanary(db, ADMIN, {
    projectId: PROJECT, apiId: api.id, stageName: "prod",
    description: "v2-canary", percentTraffic: 5, stageVariableOverrides: { v: "2" }, useStageCache: false,
  });
  assert.equal(result.status, 201);
  assert.notEqual(result.body.deploymentId, v1.body.id);
  const stage = await db.getStageByName({ apiId: api.id, name: "prod" });
  assert.equal(stage.deployment_id, v1.body.id, "base deployment must not move");
  assert.equal(stage.canary.deploymentId, result.body.deploymentId);
  assert.equal(stage.canary.percentTraffic, 5);
  resetDeployState();
});
