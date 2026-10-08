/**
 * F16 (S15): atomicity for clone handlers and deleteResource.
 *
 * Failure-injection tests proving no partial state:
 * - a clone that fails midway leaves nothing reachable and a retry with the
 *   same name succeeds (compensation via soft-delete rollback);
 * - a failing clone handler runs registered rollbacks in reverse order;
 * - a deleteResource that fails after deleting methods restores them.
 *
 * Uses the S03 in-memory fake db (soft-delete semantics mirror Postgres).
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  CLONE_HANDLERS,
  cloneApi,
  createApi,
  registerCloneHandler,
} from "../../lib/control/apis.mjs";
import {
  createResource,
  deleteResource,
  getMethod,
  listResources,
  putMethod,
} from "../../lib/control/rest-resources.mjs";
import { createFakeDb } from "../s03/fake-db.mjs";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const actor = { type: "user", userId: "u1" };
const db = () => createFakeDb({ roles: { u1: "owner" } });

async function seedRest(source) {
  const api = (await createApi(source, actor, { projectId: PROJECT, name: "Shop", protocol: "REST" })).body;
  const root = (await listResources(source, actor, { projectId: PROJECT, apiId: api.id })).items[0];
  const pets = (await createResource(source, actor, { projectId: PROJECT, apiId: api.id, parentId: root.id, pathPart: "pets" })).body;
  await putMethod(source, actor, { projectId: PROJECT, apiId: api.id, resourceId: pets.id, httpMethod: "GET", fields: {} });
  return { api, pets };
}

/** Wraps a db so the named method throws on its Nth call (failure injection). */
function failingDb(inner, method, times = 1) {
  let calls = 0;
  return new Proxy(inner, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function" || property !== method) return value;
      return async (...args) => {
        calls += 1;
        if (calls === times) throw new Error(`injected failure in ${method}`);
        return value.apply(target, args);
      };
    },
  });
}

async function retryCloneSucceeds(source, apiId, name) {
  const cloned = await cloneApi(source, actor, { projectId: PROJECT, apiId, name });
  assert.equal(cloned.status, 201);
  return cloned.body;
}

test("F16: clone failing mid-copy leaves no partial state (retry converges)", async () => {
  // Fail at several points: resource rows, method rows, route rows, handler.
  // Routes live in their own table, so the route case seeds route rows too.
  const seeders = {
    insertResource: async (source) => seedRest(source),
    insertMethod: async (source) => seedRest(source),
    insertRoute: async (source) => {
      const seeded = await seedRest(source);
      await source.insertRoute({ project_id: PROJECT, api_id: seeded.api.id, route_key: "GET /pets" });
      await source.insertRoute({ project_id: PROJECT, api_id: seeded.api.id, route_key: "POST /pets" });
      return seeded;
    },
  };
  // Failure call indexes: resource copy writes root then /pets (fail on the
  // 2nd); one method row exists (fail on the 1st); two route rows (2nd).
  const failAt = { insertResource: 2, insertMethod: 1, insertRoute: 2 };
  for (const method of ["insertResource", "insertMethod", "insertRoute"]) {
    const source = db();
    const { api } = await seeders[method](source);
    const failing = failingDb(source, method, failAt[method]);
    await assert.rejects(
      cloneApi(failing, actor, { projectId: PROJECT, apiId: api.id, name: `Copy-${method}` }),
      /injected failure/,
    );
    // Nothing reachable under the failed name, and a retry converges.
    assert.equal(await source.getApiByName({ projectId: PROJECT, name: `Copy-${method}` }), null);
    assert.equal(source.audits.filter((entry) => entry.action === "api.clone").length, 0);
    await retryCloneSucceeds(source, api.id, `Copy-${method}`);
  }
});

test("F16: failing clone handler rolls back core rows and runs rollbacks", async () => {
  const source = db();
  const { api } = await seedRest(source);
  const events = [];
  const first = async () => {
    events.push("first");
  };
  first.rollback = async () => {
    events.push("first-rollback");
  };
  const failing = async () => {
    events.push("failing");
    throw new Error("handler blew up");
  };
  CLONE_HANDLERS.push(first, failing);
  try {
    await assert.rejects(
      cloneApi(source, actor, { projectId: PROJECT, apiId: api.id, name: "Copy-rollback" }),
      /handler blew up/,
    );
  } finally {
    CLONE_HANDLERS.pop();
    CLONE_HANDLERS.pop();
  }
  assert.deepEqual(events, ["first", "failing", "first-rollback"]);
  assert.equal(await source.getApiByName({ projectId: PROJECT, name: "Copy-rollback" }), null);
  await retryCloneSucceeds(source, api.id, "Copy-rollback");
});

test("F16: registerCloneHandler accepts a rollback option", async () => {
  const source = db();
  const { api } = await seedRest(source);
  const events = [];
  const rollback = async () => {
    events.push("rolled-back");
  };
  registerCloneHandler(async () => {
    throw new Error("nope");
  }, { rollback });
  try {
    await assert.rejects(
      cloneApi(source, actor, { projectId: PROJECT, apiId: api.id, name: "Copy-opt" }),
      /nope/,
    );
  } finally {
    CLONE_HANDLERS.pop();
  }
  assert.deepEqual(events, ["rolled-back"]);
  assert.equal(await source.getApiByName({ projectId: PROJECT, name: "Copy-opt" }), null);
  await retryCloneSucceeds(source, api.id, "Copy-opt");
});

test("F16: deleteResource failing after method delete restores the methods", async () => {
  const source = db();
  const { api, pets } = await seedRest(source);
  const failing = failingDb(source, "deleteResources", 1);
  await assert.rejects(
    deleteResource(failing, actor, { projectId: PROJECT, apiId: api.id, resourceId: pets.id, recursive: true }),
    /injected failure/,
  );
  // The method is back and the resource still resolves.
  const method = await getMethod(source, actor, { projectId: PROJECT, apiId: api.id, resourceId: pets.id, httpMethod: "GET" });
  assert.equal(method.httpMethod, "GET");
  const items = (await listResources(source, actor, { projectId: PROJECT, apiId: api.id })).items;
  assert.ok(items.some((entry) => entry.id === pets.id));
});

test("F16: deleteResource success path still deletes methods and resources", async () => {
  const source = db();
  const { api, pets } = await seedRest(source);
  const out = await deleteResource(source, actor, { projectId: PROJECT, apiId: api.id, resourceId: pets.id, recursive: true });
  assert.equal(out.deleted, true);
  await assert.rejects(
    getMethod(source, actor, { projectId: PROJECT, apiId: api.id, resourceId: pets.id, httpMethod: "GET" }),
    (error) => error.code === "not_found" || error.status === 404,
  );
});
