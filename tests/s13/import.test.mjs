import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createFakeDb } from "./fake-db.mjs";
import { importExistingApi, importNewApi } from "../../lib/control/openapi-import.mjs";
import { createDeployment } from "../../lib/control/deployments.mjs";
import { exportStage } from "../../lib/control/openapi-export.mjs";
import { planImport } from "../../lib/gateway/distribution/openapi.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PROJECT = "22222222-2222-4222-8222-222222222222";
const ADMIN = { type: "user", userId: "u-admin" };

function rig() {
  return createFakeDb({ roles: { "u-admin": "admin" } });
}

async function petstoreDoc() {
  return JSON.parse(await readFile(join(ROOT, "tests", "fixtures", "petstore.json"), "utf8"));
}

test("S13A: AWS PetStore OpenAPI (with x-amazon-apigateway-integration HTTP and mock) imports with zero warnings; deploy + export(aws) round-trips semantically (same routes, integrations, mappings)", async () => {
  const db = rig();
  const doc = await petstoreDoc();
  const created = await importNewApi(db, ADMIN, { projectId: PROJECT, body: { document: doc }, options: {} });
  assert.equal(created.status, 201);
  assert.deepEqual(created.body.warnings, []);
  assert.equal(created.body.summary.added > 0, true);
  const apiId = created.body.api.id;

  // Draft holds the resources, methods, models.
  const resources = await db.listResourcesByApi({ apiId });
  assert.ok(resources.some((row) => row.path === "/pets"));
  assert.ok(resources.some((row) => row.path === "/pets/{petId}"));
  const models = await db.listModels({ projectId: PROJECT, apiId });
  assert.deepEqual(models.map((row) => row.name).sort(), ["Error", "NewPet", "Pet", "Pets"]);

  // Deploy, then export with aws extensions.
  const deployed = await createDeployment(db, ADMIN, { projectId: PROJECT, apiId, description: "v1", stageName: "prod" });
  assert.equal(deployed.body.stage, "prod");
  const exported = await exportStage(db, ADMIN, {
    projectId: PROJECT, apiId, stageName: "prod",
    query: { type: "oas30", format: "json", extensions: "aws" },
  });
  const out = exported.document;
  assert.equal(out.openapi, "3.0.3");
  assert.ok(out.paths["/pets"].get["x-amazon-apigateway-integration"]);
  assert.equal(out.paths["/pets"].get["x-amazon-apigateway-integration"].type, "http");
  assert.equal(out.paths["/pets"].post["x-amazon-apigateway-integration"].type, "mock");
  assert.ok(out.components.schemas.Pet);

  // Re-import the aws export into a fresh API: same operations/integrations/mappings.
  const db2 = rig();
  const second = await importNewApi(db2, ADMIN, { projectId: PROJECT, body: { document: out }, options: {} });
  assert.deepEqual(second.body.warnings, []);
  const before = planImport(doc, {}).plan;
  const after = planImport(out, {}).plan;
  const shape = (plan) => plan.operations.map((op) => ({
    path: op.path, method: op.method,
    integrationType: op.integration?.type ?? null,
    uri: op.integration?.uri ?? null,
    params: op.requestParameters,
  })).sort((a, b) => `${a.method} ${a.path}`.localeCompare(`${b.method} ${b.path}`));
  assert.deepEqual(shape(after), shape(before));
});

test("S13A: Lambda ARN integration URI translated to aws_lambda function provider; VPC_LINK becomes connector warning when unmapped", async () => {
  const db = rig();
  const doc = {
    openapi: "3.0.3",
    info: { title: "Lambda API", version: "1" },
    paths: {
      "/fn": {
        get: {
          operationId: "invoke",
          responses: { 200: { description: "ok" } },
          "x-amazon-apigateway-integration": {
            type: "aws_proxy",
            httpMethod: "POST",
            uri: "arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:123456789012:function:hello/invocations",
          },
        },
      },
      "/private": {
        get: {
          operationId: "wired",
          responses: { 200: { description: "ok" } },
          "x-amazon-apigateway-integration": {
            type: "http_proxy",
            httpMethod: "GET",
            uri: "http://internal.example/hello",
            connectionType: "VPC_LINK",
            connectionId: "no-such-link",
          },
        },
      },
    },
  };
  const created = await importNewApi(db, ADMIN, { projectId: PROJECT, body: { document: doc }, options: {} });
  assert.equal(created.body.warnings.length, 1);
  assert.match(created.body.warnings[0].message, /VPC_LINK/);
  const integrations = await db.listIntegrations({ apiId: created.body.api.id });
  const lambda = integrations.find((row) => row.type === "FUNCTION_PROXY");
  assert.ok(lambda);
  assert.deepEqual(lambda.function, { provider: "aws_lambda", functionArn: "arn:aws:lambda:us-east-1:123456789012:function:hello" });
  const linked = integrations.find((row) => row.connection_type === "CONNECTOR");
  assert.ok(linked);
  assert.equal(linked.connector_id, null);
});

test("S13A: failOnWarnings aborts with no writes; merge never deletes; overwrite replaces draft but keeps API id", async () => {
  const db = rig();
  const warningDoc = {
    swagger: "2.0",
    info: { title: "Warn", version: "1" },
    paths: {
      "/a": {
        get: {
          responses: { 200: { description: "ok" } },
          "x-amazon-apigateway-integration": { type: "frobnicate", uri: "http://127.0.0.1/x" },
        },
      },
    },
  };
  await assert.rejects(
    importNewApi(db, ADMIN, { projectId: PROJECT, body: { document: warningDoc }, options: { failOnWarnings: true } }),
    (error) => error.code === "import_warnings",
  );
  assert.equal(db._maps.apis.size, 0);

  // Seed an API with one method, then merge a doc with two methods.
  const base = await importNewApi(db, ADMIN, {
    projectId: PROJECT,
    body: { document: await petstoreDoc() },
    options: {},
  });
  const apiId = base.body.api.id;
  const before = await db.listMethodsByApi({ apiId });
  assert.equal(before.length, 3);
  const extra = {
    swagger: "2.0",
    info: { title: "PetStore", version: "1.0.0" },
    paths: {
      "/pets": {
        get: {
          operationId: "listPets",
          responses: { 200: { description: "ok" } },
          "x-amazon-apigateway-integration": { type: "mock" },
        },
      },
      "/owners": {
        get: {
          operationId: "listOwners",
          responses: { 200: { description: "ok" } },
          "x-amazon-apigateway-integration": { type: "mock" },
        },
      },
    },
  };
  const merged = await importExistingApi(db, ADMIN, { projectId: PROJECT, apiId, body: { document: extra }, options: { mode: "merge" } });
  assert.equal(merged.summary.removed, 0);
  const afterMerge = await db.listMethodsByApi({ apiId });
  // /pets/{petId} GET survived the merge (never deletes); /owners GET added.
  assert.equal(afterMerge.length, 4);

  const replaced = await importExistingApi(db, ADMIN, { projectId: PROJECT, apiId, body: { document: extra }, options: { mode: "overwrite" } });
  assert.ok(replaced.summary.removed > 0);
  assert.equal(replaced.apiId, apiId);
  const afterOverwrite = await db.listMethodsByApi({ apiId });
  assert.equal(afterOverwrite.length, 2);
  const api = await db.getApiByRef({ projectId: PROJECT, ref: apiId });
  assert.equal(api.id, apiId);
});
