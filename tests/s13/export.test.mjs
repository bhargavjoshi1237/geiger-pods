import assert from "node:assert/strict";
import test from "node:test";
import AjvDraft04 from "ajv-draft-04";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createFakeDb } from "./fake-db.mjs";
import { importNewApi } from "../../lib/control/openapi-import.mjs";
import { createDeployment } from "../../lib/control/deployments.mjs";
import { exportDraft, exportStage } from "../../lib/control/openapi-export.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PROJECT = "33333333-3333-4333-8333-333333333333";
const ADMIN = { type: "user", userId: "u-admin" };

function rig() {
  return createFakeDb({ roles: { "u-admin": "admin" } });
}

async function seedPetstore(db) {
  const doc = JSON.parse(await readFile(join(ROOT, "tests", "fixtures", "petstore.json"), "utf8"));
  const created = await importNewApi(db, ADMIN, { projectId: PROJECT, body: { document: doc }, options: {} });
  const apiId = created.body.api.id;
  await createDeployment(db, ADMIN, { projectId: PROJECT, apiId, description: "v1", stageName: "prod" });
  return apiId;
}

test("S13A: export reflects deployed stage, not draft edits made after deploy", async () => {
  const db = rig();
  const apiId = await seedPetstore(db);
  const first = await exportStage(db, ADMIN, {
    projectId: PROJECT, apiId, stageName: "prod",
    query: { type: "oas30", format: "json", extensions: "none" },
  });
  assert.ok(first.document.paths["/pets"]);

  // Add a draft-only resource after the deploy (with its own integration
  // so the draft still compiles).
  const root = (await db.listResourcesByApi({ apiId })).find((row) => row.path === "/");
  const added = await db.insertResource({ project_id: PROJECT, api_id: apiId, parent_id: root.id, path_part: "draft-only", path: "/draft-only" });
  const mock = await db.insertIntegration({
    project_id: PROJECT, api_id: apiId, public_id: "draftmock1",
    type: "MOCK", integration_method: "ANY", uri: null,
    connection_type: "INTERNET", connector_id: null, timeout_ms: 29000,
    backend_auth: null, function: null, aws: null,
  });
  await db.insertMethod({
    project_id: PROJECT, api_id: apiId, resource_id: added.id, http_method: "GET",
    authorization_type: "NONE", authorizer_id: null, authorization_scopes: [],
    api_key_required: false, request_validator_id: null, request_parameters: {},
    request_models: {}, integration_id: mock.id, settings: {},
  });

  // Stage export is unchanged (artifact, not draft)…
  const second = await exportStage(db, ADMIN, {
    projectId: PROJECT, apiId, stageName: "prod",
    query: { type: "oas30", format: "json", extensions: "none" },
  });
  assert.deepEqual(Object.keys(second.document.paths).sort(), Object.keys(first.document.paths).sort());

  // …while draft export sees the new path.
  const draft = await exportDraft(db, ADMIN, { projectId: PROJECT, apiId, query: { type: "oas30", format: "json", extensions: "none" } });
  assert.ok(draft.document.paths["/draft-only"]);
});

test("S13A: postman export opens as valid v2.1 collection (schema validation)", async () => {
  const db = rig();
  const apiId = await seedPetstore(db);
  const exported = await exportStage(db, ADMIN, {
    projectId: PROJECT, apiId, stageName: "prod",
    query: { extensions: "postman" },
  });
  const collection = exported.document;
  assert.equal(collection.info.schema, "https://schema.getpostman.com/json/collection/v2.1.0/collection.json");
  assert.ok(collection.item.length >= 3);
  const schema = JSON.parse(await readFile(join(ROOT, "tests", "fixtures", "postman-collection-v2.1.json"), "utf8"));
  const ajv = new AjvDraft04({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);
  assert.equal(validate(collection), true, JSON.stringify(validate.errors));
  const names = collection.item.map((entry) => entry.name);
  assert.ok(names.some((name) => name.includes("listPets")));
});

test("S13A: swagger export carries host+basePath and yaml format serializes", async () => {
  const db = rig();
  const apiId = await seedPetstore(db);
  const exported = await exportStage(db, ADMIN, {
    projectId: PROJECT, apiId, stageName: "prod",
    query: { type: "swagger", format: "yaml", extensions: "aws", domain: "api.example.com" },
  });
  assert.equal(exported.format, "yaml");
  assert.match(exported.document, /swagger: '2\.0'|swagger: "2\.0"/);
  assert.match(exported.document, /api\.example\.com/);
});
