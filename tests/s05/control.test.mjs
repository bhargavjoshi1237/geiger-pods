import assert from "node:assert/strict";
import test from "node:test";
import { createFakeDb } from "./fake-db.mjs";
import { createDeployment, deleteDeployment, diffDeployments, resetDeployState, runAutoDeploy, scheduleAutoDeploy, setDeployClock } from "../../lib/control/deployments.mjs";
import { createStage, updateStagePointer, rollbackStage, deleteStage, listStageHistory } from "../../lib/control/stages.mjs";
import { HttpError } from "../../lib/control/errors.mjs";

process.env.PODS_ALLOW_LOOPBACK = "1";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const ADMIN = { type: "user", userId: "u-admin" };

function seedRest(db, { protocol = "REST", withRoute = false } = {}) {
  return (async () => {
    const api = await db.insertApi({
      project_id: PROJECT, public_id: "a1b2c3d4e5", name: `api-${Date.now()}-${Math.random()}`,
      protocol, api_key_source: "HEADER", binary_media_types: [],
      minimum_compression_size: null, missing_route_behavior: "aws", cors: null,
      resource_policy: null, route_selection_expression: null,
    });
    const int = await db.insertIntegration({
      project_id: PROJECT, api_id: api.id, public_id: "intpub1234",
      type: protocol === "HTTP" ? "HTTP_PROXY" : "MOCK",
      integration_method: "ANY",
      uri: protocol === "HTTP" ? "http://127.0.0.1:9/echo" : null,
      connection_type: "INTERNET", connector_id: null, timeout_ms: 5000,
      backend_auth: null, function: null, aws: null,
    });
    if (protocol === "REST") {
      const res = await db.insertResource({ project_id: PROJECT, api_id: api.id, parent_id: null, path_part: "", path: "/" });
      const pets = await db.insertResource({ project_id: PROJECT, api_id: api.id, parent_id: res.id, path_part: "pets", path: "/pets" });
      await db.insertMethod({
        project_id: PROJECT, api_id: api.id, resource_id: pets.id, http_method: "GET",
        authorization_type: "NONE", authorizer_id: null, authorization_scopes: [],
        api_key_required: false, request_validator_id: null, request_parameters: {},
        request_models: {}, integration_id: int.id,
      });
    } else {
      await db.insertRoute({
        project_id: PROJECT, api_id: api.id,
        route_key: withRoute ? "GET /pets" : "$default",
        authorization_type: "NONE", authorizer_id: null, authorization_scopes: [],
        api_key_required: false, integration_id: int.id,
      });
    }
    return { api, integration: int };
  })();
}

test("S05: concurrent deploys to one API → one succeeds, other 409", async () => {
  resetDeployState();
  const db = createFakeDb({ roles: { "u-admin": "admin" } });
  const { api } = await seedRest(db);
  // Hold the first deploy open by stubbing insertDeployment with a delay.
  const original = db.insertDeployment.bind(db);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  db.insertDeployment = async (row) => {
    await gate;
    return original(row);
  };
  const first = createDeployment(db, ADMIN, { projectId: PROJECT, apiId: api.id, description: "one" });
  // Let the first acquire the lock.
  await new Promise((resolve) => setTimeout(resolve, 50));
  await assert.rejects(
    createDeployment(db, ADMIN, { projectId: PROJECT, apiId: api.id, description: "two" }),
    (error) => error instanceof HttpError && error.status === 409 && error.code === "deploy_in_progress",
  );
  release();
  const won = await first;
  assert.equal(won.status, 201);
  resetDeployState();
});

test("S05: auto-deploy redeploys after a route change; a broken change leaves the stage on the previous deployment and sets last_deployment_status_message", async () => {
  resetDeployState();
  const db = createFakeDb({ roles: { "u-admin": "admin" } });
  const api = await db.insertApi({
    project_id: PROJECT, public_id: "h1h2h3h4h5", name: `http-${Date.now()}`,
    protocol: "HTTP", api_key_source: "HEADER", binary_media_types: [],
    minimum_compression_size: null, missing_route_behavior: "aws", cors: null,
    resource_policy: null, route_selection_expression: null,
  });
  const int = await db.insertIntegration({
    project_id: PROJECT, api_id: api.id, public_id: "intpub9999", type: "HTTP_PROXY",
    integration_method: "ANY", uri: "http://127.0.0.1:9/echo",
    connection_type: "INTERNET", connector_id: null, timeout_ms: 5000,
    backend_auth: null, function: null, aws: null,
  });
  await db.insertRoute({
    project_id: PROJECT, api_id: api.id, route_key: "$default",
    authorization_type: "NONE", authorizer_id: null, authorization_scopes: [],
    api_key_required: false, integration_id: int.id,
  });
  const stage = await db.insertStage({
    project_id: PROJECT, api_id: api.id, name: "$default",
    deployment_id: null, variables: {}, auto_deploy: true,
  });
  const first = await runAutoDeploy(db, { projectId: PROJECT, apiId: api.id });
  assert.equal(first.status, "deployed");
  const pointed = await db.getStageByName({ apiId: api.id, name: "$default" });
  assert.ok(pointed.deployment_id);
  const goodId = pointed.deployment_id;

  // Add a route → next auto-deploy moves the pointer.
  await db.insertRoute({
    project_id: PROJECT, api_id: api.id, route_key: "GET /extra",
    authorization_type: "NONE", authorizer_id: null, authorization_scopes: [],
    api_key_required: false, integration_id: int.id,
  });
  // Rate-limit would block an immediate second deploy; advance the clock.
  setDeployClock({ now: () => Date.now() + 5000 });
  const second = await runAutoDeploy(db, { projectId: PROJECT, apiId: api.id });
  assert.equal(second.status, "deployed");
  const moved = await db.getStageByName({ apiId: api.id, name: "$default" });
  assert.notEqual(moved.deployment_id, goodId);

  // Break the draft (route without target, no $default fallback removed).
  // Remove the $default route's integration by deleting it and adding a bad route.
  const routes = await db.listRoutesByApi({ apiId: api.id });
  for (const route of routes) {
    if (route.route_key === "$default") await db.deleteRoute({ id: route.id });
  }
  await db.insertRoute({
    project_id: PROJECT, api_id: api.id, route_key: "GET /broken",
    authorization_type: "NONE", authorizer_id: null, authorization_scopes: [],
    api_key_required: false, integration_id: null,
  });
  const failed = await runAutoDeploy(db, { projectId: PROJECT, apiId: api.id });
  assert.equal(failed.status, "failed");
  const stuck = await db.getStageByName({ apiId: api.id, name: "$default" });
  assert.equal(stuck.deployment_id, moved.deployment_id);
  assert.ok(stuck.last_deployment_status_message);
  void stage;
  resetDeployState();
});

test("S05: deleting a deployment referenced by a stage → 409 naming the stage", async () => {
  resetDeployState();
  const db = createFakeDb({ roles: { "u-admin": "admin" } });
  const { api } = await seedRest(db);
  const created = await createDeployment(db, ADMIN, { projectId: PROJECT, apiId: api.id, description: "v1", stageName: "prod" });
  const deploymentId = created.body.id;
  await assert.rejects(
    deleteDeployment(db, ADMIN, { projectId: PROJECT, apiId: api.id, deploymentId }),
    (error) => error instanceof HttpError && error.status === 409 && /prod/.test(error.message),
  );
  // Unreferenced deploys delete cleanly.
  setDeployClock({ now: () => Date.now() + 5000 });
  const second = await createDeployment(db, ADMIN, { projectId: PROJECT, apiId: api.id, description: "v2" });
  // Diff works between the two revisions.
  const diff = await diffDeployments(db, ADMIN, {
    projectId: PROJECT, apiId: api.id, deploymentIdA: deploymentId, deploymentIdB: second.body.id,
  });
  assert.ok(Array.isArray(diff.changes));
  const removed = await deleteDeployment(db, ADMIN, { projectId: PROJECT, apiId: api.id, deploymentId: second.body.id });
  assert.equal(removed.deleted, true);
  resetDeployState();
});

test("S05: rollback restores exact previous behavior; stage_history records both moves", async () => {
  resetDeployState();
  const db = createFakeDb({ roles: { "u-admin": "admin" } });
  const { api } = await seedRest(db);
  const v1 = await createDeployment(db, ADMIN, { projectId: PROJECT, apiId: api.id, description: "v1", stageName: "prod" });
  // Advance past the 2 s rate limit.
  setDeployClock({ now: () => Date.now() + 5000 });
  const v2 = await createDeployment(db, ADMIN, { projectId: PROJECT, apiId: api.id, description: "v2", stageName: "prod" });
  const stage = await db.getStageByName({ apiId: api.id, name: "prod" });
  assert.equal(stage.deployment_id, v2.body.id);
  const back = await rollbackStage(db, ADMIN, {
    projectId: PROJECT, apiId: api.id, stageName: "prod", deploymentId: v1.body.id,
  });
  assert.equal(back.deploymentId, v1.body.id);
  const { items } = await listStageHistory(db, ADMIN, { projectId: PROJECT, apiId: api.id, stageName: "prod" });
  assert.equal(items.length, 3);
  assert.deepEqual(items.map((entry) => entry.reason), ["deploy", "deploy", "rollback"]);
  resetDeployState();
});
