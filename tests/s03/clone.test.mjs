import assert from "node:assert/strict";
import test from "node:test";

import { CLONE_HANDLERS, cloneApi, createApi, registerCloneHandler } from "../../lib/control/apis.mjs";
import { createResource, listResources, putMethod } from "../../lib/control/rest-resources.mjs";
import { createRoute } from "../../lib/control/http-routes.mjs";
import { compileHttpRoutes, matchHttpRoute } from "../../lib/gateway/core/match/http-routes.mjs";
import { compileRestResources, matchRestResource } from "../../lib/gateway/core/match/rest-resources.mjs";
import { createFakeDb } from "./fake-db.mjs";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const db = () => createFakeDb({ roles: { u1: "owner" } });
const actor = { type: "user", userId: "u1" };

test("S03: clone produces identical match results with new ids", async () => {
  const source = db();
  const api = (await createApi(source, actor, { projectId: PROJECT, name: "Shop", protocol: "REST", requestId: "r" })).body;
  const root = (await listResources(source, actor, { projectId: PROJECT, apiId: api.id })).items[0];
  const pets = (await createResource(source, actor, { projectId: PROJECT, apiId: api.id, parentId: root.id, pathPart: "pets" })).body;
  const item = (await createResource(source, actor, { projectId: PROJECT, apiId: api.id, parentId: pets.id, pathPart: "{id}" })).body;
  await putMethod(source, actor, { projectId: PROJECT, apiId: api.id, resourceId: pets.id, httpMethod: "GET", fields: { operationName: "listPets" } });
  await putMethod(source, actor, { projectId: PROJECT, apiId: api.id, resourceId: item.id, httpMethod: "ANY", fields: {} });

  const seen = [];
  CLONE_HANDLERS.push(async (database, args) => {
    seen.push(args);
    assert.equal(database, source);
  });
  let cloned;
  try {
    cloned = await cloneApi(source, actor, { projectId: PROJECT, apiId: api.id, requestId: "c" });
  } finally {
    assert.equal(seen.length, 1);
    CLONE_HANDLERS.pop();
  }
  assert.equal(cloned.status, 201);
  assert.notEqual(cloned.body.id, api.id);
  assert.notEqual(cloned.body.publicId, api.publicId);
  assert.equal(cloned.body.name, "Shop (copy)");
  assert.equal(seen[0].sourceApiId, api.id);
  assert.equal(seen[0].targetApiId, cloned.body.id);
  assert.ok(seen[0].idMaps.resources.get(pets.id));

  async function draft(database, apiId) {
    const resources = await database.listResourcesByApi({ apiId });
    const methods = await database.listMethodsByApi({ apiId });
    return { resources, methods };
  }
  const before = await draft(source, api.id);
  const after = await draft(source, cloned.body.id);
  assert.equal(after.resources.length, before.resources.length);
  assert.equal(after.methods.length, before.methods.length);
  assert.deepEqual(
    after.resources.map((row) => row.path).sort(),
    before.resources.map((row) => row.path).sort(),
  );
  // Identical match results (modulo fresh ids).
  const compile = (snapshot) => compileRestResources(
    snapshot.resources.map((row) => ({ id: row.id, path: row.path })),
    snapshot.methods.map((row) => ({ id: row.id, resourceId: row.resource_id, httpMethod: row.http_method })),
  );
  for (const [method, path] of [["GET", "/pets"], ["GET", "/pets/9"], ["DELETE", "/pets/9"], ["POST", "/pets"]]) {
    const a = matchRestResource(compile(before), method, path);
    const b = matchRestResource(compile(after), method, path);
    assert.equal(Boolean(a?.methodId), Boolean(b?.methodId), `${method} ${path}`);
    assert.equal(a?.resourcePath, b?.resourcePath, `${method} ${path}`);
    assert.deepEqual(a?.pathParameters, b?.pathParameters, `${method} ${path}`);
  }

  // HTTP routes clone the same way.
  const http = db();
  const hApi = (await createApi(http, actor, { projectId: PROJECT, name: "H", protocol: "HTTP", requestId: "r" })).body;
  await createRoute(http, actor, { projectId: PROJECT, apiId: hApi.id, routeKey: "GET /pets/{id}" });
  await createRoute(http, actor, { projectId: PROJECT, apiId: hApi.id, routeKey: "ANY /{proxy+}" });
  const hClone = (await cloneApi(http, actor, { projectId: PROJECT, apiId: hApi.id })).body;
  const compileRoutes = async (database, apiId) =>
    compileHttpRoutes((await database.listRoutesByApi({ apiId })).map((row) => ({ id: row.id, routeKey: row.route_key })));
  const hBefore = await compileRoutes(http, hApi.id);
  const hAfter = await compileRoutes(http, hClone.id);
  for (const [method, path] of [["GET", "/pets/1"], ["POST", "/a/b"]]) {
    const a = matchHttpRoute(hBefore, method, path);
    const b = matchHttpRoute(hAfter, method, path);
    assert.equal(a?.routeKey, b?.routeKey, `${method} ${path}`);
    assert.deepEqual(a?.pathParameters, b?.pathParameters, `${method} ${path}`);
    assert.notEqual(a?.routeId, b?.routeId, "ids are fresh");
  }
});

test("S03: registerCloneHandler rejects non-functions", async () => {
  assert.throws(() => registerCloneHandler("nope"), /requires a function/);
  const before = CLONE_HANDLERS.length;
  registerCloneHandler(async () => {});
  assert.equal(CLONE_HANDLERS.length, before + 1);
  CLONE_HANDLERS.pop();
});
