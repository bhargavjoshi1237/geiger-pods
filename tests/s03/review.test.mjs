import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { HttpError } from "../../lib/control/errors.mjs";
import { cloneApi, createApi } from "../../lib/control/apis.mjs";
import { createResource, deleteResource, listResources } from "../../lib/control/rest-resources.mjs";
import { createFakeDb } from "./fake-db.mjs";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const ownerDb = () => createFakeDb({ roles: { u1: "owner" } });
const actor = { type: "user", userId: "u1" };

const HERE = dirname(fileURLToPath(import.meta.url));
const METHOD_ROUTE_FILE = join(
  HERE, "..", "..",
  "app", "api", "v1", "projects", "[projectId]",
  "apis", "[apiId]", "resources", "[resourceId]", "methods", "[httpMethod]", "route.js",
);

function loadMethodArgs() {
  const src = readFileSync(METHOD_ROUTE_FILE, "utf8");
  const start = src.indexOf("function methodArgs");
  assert.ok(start !== -1, "methodArgs helper exists in the method route file");
  const end = src.indexOf("\n}\n", start);
  assert.ok(end !== -1, "methodArgs function body terminates");
  const fnSrc = src.slice(start, end + 3);
  return new Function(`${fnSrc}; return methodArgs;`)();
}

test("S03 review: method routes keep projectId", () => {
  const methodArgs = loadMethodArgs();
  const projectId = "proj-keep-me";
  const params = { apiId: "api-1", resourceId: "res-1", httpMethod: "GET" };
  // The route handlers build service args as `{ projectId, ...methodArgs(params) }`.
  // If methodArgs returns its own projectId key (undefined), the spread clobbers
  // the real project id and every method call misses its API (404).
  const built = { projectId, ...methodArgs(params) };
  assert.equal(built.projectId, projectId, "spread must preserve the outer projectId");
  assert.equal(built.apiId, params.apiId);
  assert.equal(built.resourceId, params.resourceId);
  assert.equal(built.httpMethod, params.httpMethod);
});

test("S03 review: root resource cannot be deleted", async () => {
  const db = ownerDb();
  const api = (await createApi(db, actor, { projectId: PROJECT, name: "RootDel", protocol: "REST", requestId: "r" })).body;
  const root = (await listResources(db, actor, { projectId: PROJECT, apiId: api.id })).items[0];
  assert.equal(root.path, "/");
  await createResource(db, actor, { projectId: PROJECT, apiId: api.id, parentId: root.id, pathPart: "pets" });

  await assert.rejects(
    deleteResource(db, actor, { projectId: PROJECT, apiId: api.id, resourceId: root.id }),
    (error) => error instanceof HttpError && error.status === 422,
    "deleting root without recursive should be rejected",
  );
  await assert.rejects(
    deleteResource(db, actor, { projectId: PROJECT, apiId: api.id, resourceId: root.id, recursive: true }),
    (error) => error instanceof HttpError && error.status === 422,
    "deleting root with recursive should also be rejected",
  );
  // The tree must be intact: no orphaned branch left behind.
  const remaining = await db.listResourcesByApi({ apiId: api.id });
  assert.deepEqual(remaining.map((row) => row.path).sort(), ["/", "/pets"]);
});

test("S03 review: clone aborts on methods with missing resources", async () => {
  const db = ownerDb();
  const api = (await createApi(db, actor, { projectId: PROJECT, name: "Orphan", protocol: "REST", requestId: "r" })).body;
  // Bypass the service to simulate a corrupt draft: a method whose resource is gone.
  await db.insertMethod({
    project_id: PROJECT, api_id: api.id, resource_id: "00000000-0000-4000-8000-000000000000",
    http_method: "GET", authorization_type: "NONE", authorization_scopes: [],
    api_key_required: false, operation_name: "", request_validator_id: null,
    request_parameters: {}, request_models: {}, integration_id: null, settings: {},
  });
  await assert.rejects(
    cloneApi(db, actor, { projectId: PROJECT, apiId: api.id }),
    (error) => error instanceof HttpError && error.status === 500,
    "clone of a corrupt draft should fail closed with 500, not copy a dangling ref",
  );
  // Fail before side effects: no half-cloned copy left behind.
  assert.equal(await db.getApiByName({ projectId: PROJECT, name: "Orphan (copy)" }), null);
});
