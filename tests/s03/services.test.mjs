import assert from "node:assert/strict";
import test from "node:test";

import { HttpError } from "../../lib/control/errors.mjs";
import {
  createApi,
  deleteApi,
  getApi,
  listApis,
  provisionQuickCreateTarget,
  updateApi,
} from "../../lib/control/apis.mjs";
import { createResource, deleteResource, getMethod, listResources, patchMethod, putMethod } from "../../lib/control/rest-resources.mjs";
import { createRoute, deleteRoute, getRoute, listRoutes, updateRoute } from "../../lib/control/http-routes.mjs";
import { createFakeDb } from "./fake-db.mjs";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT = "22222222-2222-4222-8222-222222222222";
const ownerDb = () => createFakeDb({ roles: { u1: "owner" } });
const actor = { type: "user", userId: "u1" };

async function denies(promise, status, code) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof HttpError, `expected HttpError, got ${error}`);
    assert.equal(error.status, status);
    assert.equal(error.code, code);
    return true;
  });
}

async function createRestApi(db, name = "Pets") {
  const created = await createApi(db, actor, { projectId: PROJECT, name, protocol: "REST", requestId: "r1" });
  assert.equal(created.status, 201);
  return created.body;
}

test("S03: REST create inserts root \"/\"; protocol change is 422", async () => {
  const db = ownerDb();
  const api = await createRestApi(db);
  assert.match(api.publicId, /^[a-z0-9]{10}$/);
  const { items } = await listResources(db, actor, { projectId: PROJECT, apiId: api.id });
  assert.equal(items.length, 1);
  assert.equal(items[0].path, "/");
  assert.equal(items[0].parentId, null);

  await denies(updateApi(db, actor, { projectId: PROJECT, apiId: api.id, patch: { protocol: "HTTP" } }), 422, "invalid_input");
  // Same value is a no-op, not a change.
  const same = await updateApi(db, actor, { projectId: PROJECT, apiId: api.id, patch: { protocol: "REST", description: "Shop" } });
  assert.equal(same.description, "Shop");
  // Other-project APIs are invisible.
  await denies(getApi(db, actor, { projectId: OTHER_PROJECT, apiId: api.id }), 404, "not_found");
});

test("S03: two variable siblings rejected (409); greedy resource cannot have children (422)", async () => {
  const db = ownerDb();
  const api = await createRestApi(db);
  const root = (await listResources(db, actor, { projectId: PROJECT, apiId: api.id })).items[0];
  const pets = (await createResource(db, actor, { projectId: PROJECT, apiId: api.id, parentId: root.id, pathPart: "pets" })).body;
  assert.equal(pets.path, "/pets");
  await createResource(db, actor, { projectId: PROJECT, apiId: api.id, parentId: pets.id, pathPart: "{id}" });
  await denies(
    createResource(db, actor, { projectId: PROJECT, apiId: api.id, parentId: pets.id, pathPart: "{other}" }),
    409,
    "conflict",
  );
  // Literal duplicates also conflict.
  await denies(
    createResource(db, actor, { projectId: PROJECT, apiId: api.id, parentId: root.id, pathPart: "pets" }),
    409,
    "conflict",
  );
  const files = (await createResource(db, actor, { projectId: PROJECT, apiId: api.id, parentId: root.id, pathPart: "files" })).body;
  const proxy = (await createResource(db, actor, { projectId: PROJECT, apiId: api.id, parentId: files.id, pathPart: "{proxy+}" })).body;
  assert.equal(proxy.path, "/files/{proxy+}");
  await denies(
    createResource(db, actor, { projectId: PROJECT, apiId: api.id, parentId: proxy.id, pathPart: "child" }),
    422,
    "invalid_input",
  );
  // Deleting a branch with children needs recursive=true.
  await denies(deleteResource(db, actor, { projectId: PROJECT, apiId: api.id, resourceId: files.id }), 409, "conflict");
  const deleted = await deleteResource(db, actor, { projectId: PROJECT, apiId: api.id, resourceId: files.id, recursive: true });
  assert.equal(deleted.deletedResources, 2);
});

test("S03: invalid route keys rejected: \"GET pets\", \"FETCH /a\", \"GET /{a+}/b\"", async () => {
  const db = ownerDb();
  const created = await createApi(db, actor, { projectId: PROJECT, name: "Http", protocol: "HTTP", requestId: "r1" });
  const api = created.body;
  for (const routeKey of ["GET pets", "FETCH /a", "GET /{a+}/b", "GET /a/{b+}/c"]) {
    await denies(createRoute(db, actor, { projectId: PROJECT, apiId: api.id, routeKey }), 422, "invalid_input");
  }
  const route = (await createRoute(db, actor, { projectId: PROJECT, apiId: api.id, routeKey: "GET /pets/{id}" })).body;
  assert.equal(route.routeKey, "GET /pets/{id}");
  await denies(createRoute(db, actor, { projectId: PROJECT, apiId: api.id, routeKey: "GET /pets/{id}" }), 409, "conflict");
  // HTTP routes do not belong on REST APIs.
  const rest = await createRestApi(db, "Rest2");
  await denies(createRoute(db, actor, { projectId: PROJECT, apiId: rest.id, routeKey: "GET /x" }), 422, "invalid_input");
  // WebSocket route keys are free strings, and only WS takes apiKeyRequired.
  const ws = (await createApi(db, actor, { projectId: PROJECT, name: "Ws", protocol: "WEBSOCKET", requestId: "r1" })).body;
  const custom = (await createRoute(db, actor, { projectId: PROJECT, apiId: ws.id, routeKey: "sendmessage", apiKeyRequired: true })).body;
  assert.equal(custom.routeKey, "sendmessage");
  await denies(createRoute(db, actor, { projectId: PROJECT, apiId: api.id, routeKey: "GET /k", apiKeyRequired: true }), 422, "invalid_input");
});

test("S03: route writes require pods.route.write (service-level)", async () => {
  const memberDb = createFakeDb({ roles: { admin: "admin", member: "member", manager: "manager" } });
  const api = (await createApi(memberDb, { type: "user", userId: "admin" }, { projectId: PROJECT, name: "H", protocol: "HTTP", requestId: "r" })).body;
  await denies(
    createRoute(memberDb, { type: "user", userId: "member" }, { projectId: PROJECT, apiId: api.id, routeKey: "GET /x" }),
    403,
    "forbidden",
  );
  const ok = await createRoute(memberDb, { type: "user", userId: "manager" }, { projectId: PROJECT, apiId: api.id, routeKey: "GET /x" });
  assert.equal(ok.status, 201);
});

test("S03: scoped grant on API A cannot write API B routes", async () => {
  const { requirePermission } = await import("../../lib/control/authz.mjs");
  const db = createFakeDb({ roles: { u1: "owner", scoped: "member" } });
  const scopedActor = { type: "user", userId: "scoped" };
  const a = (await createApi(db, actor, { projectId: PROJECT, name: "A2", protocol: "HTTP", requestId: "r" })).body;
  const b = (await createApi(db, actor, { projectId: PROJECT, name: "B2", protocol: "HTTP", requestId: "r" })).body;
  db.setBindings({
    roles: [{ id: "role1", key: "api-dev", name: "API Dev", permissions: ["pods.route.write"] }],
    grants: [{
      id: "grant1", roleId: "role1", userId: "scoped", projectId: PROJECT,
      scope: { api: [a.id] }, status: "active",
    }],
  });
  // Same permission evaluation the services use: API A allowed, API B denied.
  await requirePermission(db, scopedActor, "pods.route.write", { projectId: PROJECT, apiId: a.id });
  await denies(requirePermission(db, scopedActor, "pods.route.write", { projectId: PROJECT, apiId: b.id }), 403, "forbidden");
  const ok = await createRoute(db, scopedActor, { projectId: PROJECT, apiId: a.id, routeKey: "GET /a" });
  assert.equal(ok.status, 201);
  await denies(createRoute(db, scopedActor, { projectId: PROJECT, apiId: b.id, routeKey: "GET /b" }), 403, "forbidden");
});

test("S03: API CRUD validates input, versions and capability gates", async () => {
  const db = ownerDb();
  await denies(createApi(db, actor, { projectId: PROJECT, name: "", protocol: "REST" }), 422, "invalid_input");
  await denies(createApi(db, actor, { projectId: PROJECT, name: "X", protocol: "SIP" }), 422, "invalid_input");
  await denies(
    createApi(db, actor, { projectId: PROJECT, name: "Edge", protocol: "HTTP", endpointType: "EDGE" }),
    400,
    "capability_unsupported",
  );
  const api = await createRestApi(db, "Shop");
  await denies(createApi(db, actor, { projectId: PROJECT, name: "Shop", protocol: "HTTP" }), 409, "conflict");
  await denies(
    updateApi(db, actor, { projectId: PROJECT, apiId: api.id, patch: { description: "x" }, expectedVersion: 999 }),
    409,
    "version_conflict",
  );
  const listed = await listApis(db, actor, { projectId: PROJECT });
  assert.equal(listed.items.length, 1);
  const deleted = await deleteApi(db, actor, { projectId: PROJECT, apiId: api.id });
  assert.equal(deleted.deleted, true);
  await denies(getApi(db, actor, { projectId: PROJECT, apiId: api.id }), 404, "not_found");
  assert.equal(db.audits.map((entry) => entry.action).join(","), "api.create,api.delete");
});

test("S03: HTTP quickCreate stores the API and route and reports S04/S05 pending", async () => {
  const db = ownerDb();
  await assert.rejects(provisionQuickCreateTarget(), /quickCreate requires S04\/S05/);
  const created = await createApi(db, actor, {
    projectId: PROJECT, name: "Quick", protocol: "HTTP",
    quickCreate: { target: "https://backend.example.com/api" }, requestId: "q1",
  });
  assert.equal(created.status, 201);
  assert.match(created.body.quickCreatePending, /quickCreate requires S04\/S05/);
  const { items } = await listRoutes(db, actor, { projectId: PROJECT, apiId: created.body.id });
  assert.deepEqual(items.map((route) => route.routeKey), ["$default"]);
});

test("S03: match endpoint resolves draft routes for the UI route tester", async () => {
  const { matchDraft } = await import("../../lib/control/apis.mjs");
  const db = ownerDb();
  const api = (await createApi(db, actor, { projectId: PROJECT, name: "H", protocol: "HTTP", requestId: "r" })).body;
  await createRoute(db, actor, { projectId: PROJECT, apiId: api.id, routeKey: "GET /pets/{id}" });
  const hit = await matchDraft(db, actor, { projectId: PROJECT, apiId: api.id, method: "GET", path: "/pets/7" });
  assert.equal(hit.matched, true);
  assert.deepEqual(hit.pathParameters, { id: "7" });
  const miss = await matchDraft(db, actor, { projectId: PROJECT, apiId: api.id, method: "POST", path: "/pets/7" });
  assert.equal(miss.matched, false);
});

test("S03: methods default to NONE and validate authorization fields", async () => {
  const db = ownerDb();
  const api = await createRestApi(db);
  const root = (await listResources(db, actor, { projectId: PROJECT, apiId: api.id })).items[0];
  const pets = (await createResource(db, actor, { projectId: PROJECT, apiId: api.id, parentId: root.id, pathPart: "pets" })).body;
  const put = await putMethod(db, actor, { projectId: PROJECT, apiId: api.id, resourceId: pets.id, httpMethod: "get", fields: {} });
  assert.equal(put.status, 201);
  assert.equal(put.body.authorizationType, "NONE");
  assert.equal(put.body.httpMethod, "GET");
  await denies(
    putMethod(db, actor, { projectId: PROJECT, apiId: api.id, resourceId: pets.id, httpMethod: "GET", fields: { authorizationType: "NOPE" } }),
    422,
    "invalid_input",
  );
  const patched = await patchMethod(db, actor, {
    projectId: PROJECT, apiId: api.id, resourceId: pets.id, httpMethod: "GET",
    patch: { apiKeyRequired: true }, expectedVersion: put.body.version,
  });
  assert.equal(patched.apiKeyRequired, true);
  const fetched = await getMethod(db, actor, { projectId: PROJECT, apiId: api.id, resourceId: pets.id, httpMethod: "GET" });
  assert.equal(fetched.operationName, "");
  const httpApi = (await createApi(db, actor, { projectId: PROJECT, name: "H404", protocol: "HTTP", requestId: "r" })).body;
  const renamed = await updateRoute(db, actor, { projectId: PROJECT, apiId: httpApi.id, routeId: "missing", patch: {} }).catch((error) => error);
  assert.ok(renamed instanceof HttpError && renamed.status === 404);
  const gone = await deleteRoute(db, actor, { projectId: PROJECT, apiId: httpApi.id, routeId: "missing" }).catch((error) => error);
  assert.ok(gone instanceof HttpError && gone.status === 404);
});
