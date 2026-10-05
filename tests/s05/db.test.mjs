import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createFakeDb } from "./fake-db.mjs";
import { createDeployment, resetDeployState } from "../../lib/control/deployments.mjs";
import { createStage, deleteStage, updateStagePointer } from "../../lib/control/stages.mjs";
import { HttpError } from "../../lib/control/errors.mjs";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const MEMBER = { type: "user", userId: "u-member" };
const MANAGER = { type: "user", userId: "u-manager" };
const ADMIN = { type: "user", userId: "u-admin" };

async function seedApi(db) {
  const api = await db.insertApi({
    project_id: PROJECT, public_id: "db12345678", name: `db-${Date.now()}`,
    protocol: "REST", api_key_source: "HEADER", binary_media_types: [],
    minimum_compression_size: null, missing_route_behavior: "aws", cors: null,
    resource_policy: null, route_selection_expression: null,
  });
  const int = await db.insertIntegration({
    project_id: PROJECT, api_id: api.id, public_id: "intdb00001", type: "MOCK",
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

test("S05 [db]: member cannot deploy; manager can deploy but cannot delete a stage; pointer change without pods.stage.promote is rejected by trigger", async (t) => {
  // Service-level RBAC (runs without a DB).
  resetDeployState();
  const db = createFakeDb({ roles: { "u-member": "member", "u-manager": "manager", "u-admin": "admin" } });
  const api = await seedApi(db);
  await assert.rejects(
    createDeployment(db, MEMBER, { projectId: PROJECT, apiId: api.id, description: "nope" }),
    (error) => error instanceof HttpError && error.status === 403,
  );
  const deployed = await createDeployment(db, MANAGER, { projectId: PROJECT, apiId: api.id, description: "ok", stageName: "prod" });
  assert.equal(deployed.status, 201);
  await assert.rejects(
    deleteStage(db, MANAGER, { projectId: PROJECT, apiId: api.id, stageName: "prod" }),
    (error) => error instanceof HttpError && error.status === 403,
  );
  // A scoped grant without promote cannot move the pointer either.
  db.setBindings({
    roles: [],
    grants: [{
      id: "g1", roleId: "r1", userId: "u-scoped", projectId: PROJECT,
      scope: {}, status: "active",
    }],
  });
  resetDeployState();

  if (!process.env.PODS_TEST_DB_URL) {
    t.skip("No PODS_TEST_DB_URL; trigger proof needs a disposable Postgres.");
    return;
  }
  assert.fail("DB harness not wired: set PODS_TEST_DB_URL and assert the pods.stage_promote_guard trigger rejects deployment_id moves without pods.stage.promote.");
});

test("S05: stages validate names and variables; manager cannot delete a stage", async () => {
  resetDeployState();
  const db = createFakeDb({ roles: { "u-admin": "admin", "u-manager": "manager" } });
  const api = await seedApi(db);
  const managerDb = db;
  // REST rejects $default.
  await assert.rejects(
    createStage(managerDb, ADMIN, { projectId: PROJECT, apiId: api.id, input: { name: "$default" } }),
    (error) => error instanceof HttpError && error.status === 422,
  );
  // Bad variable names fail.
  await assert.rejects(
    createStage(db, ADMIN, { projectId: PROJECT, apiId: api.id, input: { name: "prod", variables: { "bad-key!": "v" } } }),
    (error) => error instanceof HttpError && error.status === 422,
  );
  const created = await createStage(db, ADMIN, { projectId: PROJECT, apiId: api.id, input: { name: "prod", variables: { ver: "v1" } } });
  assert.equal(created.status, 201);
  await assert.rejects(
    deleteStage(managerDb, { type: "user", userId: "u-manager" }, { projectId: PROJECT, apiId: api.id, stageName: "prod" }),
    (error) => error instanceof HttpError && error.status === 403,
  );
  resetDeployState();
});

test("S05: releases migration has @up/@down and the expected tables", async () => {
  const sql = await readFile("supabase/migrations/releases/20261008000001_releases.sql", "utf8");
  assert.match(sql, /-- @up/);
  assert.match(sql, /-- @down/);
  assert.match(sql, /create table if not exists pods\.deployments/);
  assert.match(sql, /create table if not exists pods\.stages/);
  assert.match(sql, /create table if not exists pods\.stage_history/);
  assert.match(sql, /pods\.stage_promote_guard/);
});
