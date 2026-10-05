import assert from "node:assert/strict";
import test from "node:test";

import { createModel, getModel, updateModel, deleteModel, listModels } from "../../lib/control/models.mjs";
import {
  createRequestValidator,
  listRequestValidators,
  updateRequestValidator,
  deleteRequestValidator,
} from "../../lib/control/request-validators.mjs";
import {
  createMethodResponse,
  getMethodResponse,
  updateMethodResponse,
  deleteMethodResponse,
} from "../../lib/control/method-responses.mjs";
import {
  listResponseTypes,
  putGatewayResponse,
  getGatewayResponse,
  resetGatewayResponse,
} from "../../lib/control/gateway-responses.mjs";
import { HttpError } from "../../lib/control/errors.mjs";

const PROJECT = "44444444-4444-4434-8444-444444444444";
const API = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ADMIN = { type: "user", userId: "u-admin" };
const MEMBER = { type: "user", userId: "u-member" };

function fakeDb() {
  const store = {
    models: [],
    validators: [],
    methodResponses: [],
    gatewayResponses: [],
    seq: 0,
  };
  return {
    store,
    audits: [],
    async getInheritedRole({ userId }) {
      return userId === "u-admin" ? "admin" : "member";
    },
    async listRoleBindings() {
      return { roles: [], grants: [] };
    },
    async insertAudit(entry) {
      this.audits.push(entry);
    },
    nextId() {
      store.seq += 1;
      return `id-${store.seq}`;
    },
    async listModels({ projectId, apiId, limit = 101 }) {
      return store.models.filter((row) => row.project_id === projectId && String(row.api_id) === String(apiId)).slice(0, limit);
    },
    async getModel({ projectId, apiId, name }) {
      return store.models.find((row) => row.project_id === projectId && String(row.api_id) === String(apiId) && row.name === name) ?? null;
    },
    async insertModel(row) {
      const saved = { ...row, id: this.nextId(), version: 1, created_at: "t", updated_at: "t" };
      store.models.push(saved);
      return saved;
    },
    async updateModel({ id, ...patch }) {
      const row = store.models.find((entry) => entry.id === id);
      Object.assign(row, patch);
      return row;
    },
    async deleteModel({ id }) {
      store.models = store.models.filter((row) => row.id !== id);
    },
    async listRequestValidators({ projectId, apiId }) {
      return store.validators.filter((row) => row.project_id === projectId && String(row.api_id) === String(apiId));
    },
    async getRequestValidator({ id }) {
      return store.validators.find((row) => row.id === id) ?? null;
    },
    async insertRequestValidator(row) {
      const saved = { ...row, id: this.nextId(), version: 1, created_at: "t", updated_at: "t" };
      store.validators.push(saved);
      return saved;
    },
    async updateRequestValidator({ id, ...patch }) {
      const row = store.validators.find((entry) => entry.id === id);
      Object.assign(row, patch);
      return row;
    },
    async deleteRequestValidator({ id }) {
      store.validators = store.validators.filter((row) => row.id !== id);
    },
    async listMethodResponses({ methodId }) {
      return store.methodResponses.filter((row) => String(row.method_id) === String(methodId));
    },
    async getMethodResponse({ methodId, statusCode }) {
      return store.methodResponses.find((row) => String(row.method_id) === String(methodId) && row.status_code === statusCode) ?? null;
    },
    async insertMethodResponse(row) {
      const saved = { ...row, id: this.nextId(), version: 1, created_at: "t", updated_at: "t" };
      store.methodResponses.push(saved);
      return saved;
    },
    async updateMethodResponse({ id, ...patch }) {
      const row = store.methodResponses.find((entry) => entry.id === id);
      Object.assign(row, patch);
      return row;
    },
    async deleteMethodResponse({ id }) {
      store.methodResponses = store.methodResponses.filter((row) => row.id !== id);
    },
    async listGatewayResponses({ projectId, apiId }) {
      return store.gatewayResponses.filter((row) => row.project_id === projectId && String(row.api_id) === String(apiId));
    },
    async getGatewayResponse({ apiId, responseType }) {
      return store.gatewayResponses.find((row) => String(row.api_id) === String(apiId) && row.response_type === responseType) ?? null;
    },
    async insertGatewayResponse(row) {
      const saved = { ...row, id: this.nextId(), version: 1, created_at: "t", updated_at: "t" };
      store.gatewayResponses.push(saved);
      return saved;
    },
    async updateGatewayResponse({ id, ...patch }) {
      const row = store.gatewayResponses.find((entry) => entry.id === id);
      Object.assign(row, patch);
      return row;
    },
    async deleteGatewayResponse({ id }) {
      store.gatewayResponses = store.gatewayResponses.filter((row) => row.id !== id);
    },
  };
}

const ORDER = {
  type: "object",
  properties: { name: { type: "string" } },
  required: ["name"],
};

test("S06: models CRUD enforces names, schemas, quota and versions", async () => {
  const db = fakeDb();
  await assert.rejects(
    listModels(db, null, { projectId: PROJECT, apiId: API }),
    (error) => error instanceof HttpError && error.status === 401,
  );
  const created = await createModel(db, ADMIN, { projectId: PROJECT, apiId: API, input: { name: "Order", schema: ORDER } });
  assert.equal(created.name, "Order");
  assert.equal(created.contentType, "application/json");
  assert.equal(created.version, 1);
  await assert.rejects(
    createModel(db, ADMIN, { projectId: PROJECT, apiId: API, input: { name: "Order", schema: ORDER } }),
    (error) => error instanceof HttpError && error.status === 409,
  );
  await assert.rejects(
    createModel(db, ADMIN, { projectId: PROJECT, apiId: API, input: { name: "bad name!", schema: ORDER } }),
    (error) => error instanceof HttpError && error.status === 422,
  );
  await assert.rejects(
    createModel(db, ADMIN, { projectId: PROJECT, apiId: API, input: { name: "Bad", schema: { type: "nope" } } }),
    (error) => error instanceof HttpError && error.status === 422,
  );
  await assert.rejects(
    createModel(db, MEMBER, { projectId: PROJECT, apiId: API, input: { name: "Other", schema: ORDER } }),
    (error) => error instanceof HttpError && error.status === 403,
  );
  const read = await getModel(db, MEMBER, { projectId: PROJECT, apiId: API, name: "Order" });
  assert.deepEqual(read.schema, ORDER);
  await assert.rejects(
    updateModel(db, ADMIN, { projectId: PROJECT, apiId: API, name: "Order", patch: {}, expectedVersion: 99 }),
    (error) => error instanceof HttpError && error.status === 409,
  );
  const updated = await updateModel(db, ADMIN, {
    projectId: PROJECT,
    apiId: API,
    name: "Order",
    patch: { description: "orders" },
    expectedVersion: 1,
  });
  assert.equal(updated.description, "orders");
  assert.equal(updated.version, 2);
  const deleted = await deleteModel(db, ADMIN, { projectId: PROJECT, apiId: API, name: "Order", expectedVersion: 2 });
  assert.equal(deleted.deleted, true);
  assert.equal(db.audits.map((entry) => entry.action).join(","), "model.create,model.update,model.delete");
});

test("S06: request validators CRUD with boolean flags and conflicts", async () => {
  const db = fakeDb();
  const created = await createRequestValidator(db, ADMIN, {
    projectId: PROJECT,
    apiId: API,
    input: { name: "params-only", validateRequestBody: false, validateRequestParameters: true },
  });
  assert.equal(created.validateRequestBody, false);
  assert.equal(created.validateRequestParameters, true);
  await assert.rejects(
    createRequestValidator(db, ADMIN, { projectId: PROJECT, apiId: API, input: { name: "params-only" } }),
    (error) => error instanceof HttpError && error.status === 409,
  );
  const listed = await listRequestValidators(db, MEMBER, { projectId: PROJECT, apiId: API });
  assert.equal(listed.length, 1);
  const updated = await updateRequestValidator(db, ADMIN, {
    projectId: PROJECT,
    apiId: API,
    validatorId: created.id,
    patch: { validateRequestBody: true },
    expectedVersion: 1,
  });
  assert.equal(updated.validateRequestBody, true);
  const deleted = await deleteRequestValidator(db, ADMIN, {
    projectId: PROJECT,
    apiId: API,
    validatorId: created.id,
    expectedVersion: 2,
  });
  assert.equal(deleted.deleted, true);
});

test("S06: method responses CRUD validates status, parameters and model refs", async () => {
  const db = fakeDb();
  await createModel(db, ADMIN, { projectId: PROJECT, apiId: API, input: { name: "Order", schema: ORDER } });
  await assert.rejects(
    createMethodResponse(db, ADMIN, {
      projectId: PROJECT,
      apiId: API,
      methodId: "m1",
      input: { statusCode: "99", responseParameters: {} },
    }),
    (error) => error instanceof HttpError && error.status === 422,
  );
  await assert.rejects(
    createMethodResponse(db, ADMIN, {
      projectId: PROJECT,
      apiId: API,
      methodId: "m1",
      input: { statusCode: "200", responseParameters: { "bogus": true } },
    }),
    (error) => error instanceof HttpError && error.status === 422,
  );
  await assert.rejects(
    createMethodResponse(db, ADMIN, {
      projectId: PROJECT,
      apiId: API,
      methodId: "m1",
      input: { statusCode: "200", responseParameters: {}, responseModels: { "application/json": "Missing" } },
    }),
    (error) => error instanceof HttpError && error.status === 422,
  );
  const created = await createMethodResponse(db, ADMIN, {
    projectId: PROJECT,
    apiId: API,
    methodId: "m1",
    input: {
      statusCode: "200",
      responseParameters: { "method.response.header.X-Req": true },
      responseModels: { "application/json": "Order" },
    },
  });
  assert.equal(created.statusCode, "200");
  const read = await getMethodResponse(db, MEMBER, { projectId: PROJECT, apiId: API, methodId: "m1", statusCode: "200" });
  assert.deepEqual(read.responseParameters, { "method.response.header.X-Req": true });
  const updated = await updateMethodResponse(db, ADMIN, {
    projectId: PROJECT,
    apiId: API,
    methodId: "m1",
    statusCode: "200",
    patch: { responseModels: { "application/json": "Empty" } },
    expectedVersion: 1,
  });
  assert.deepEqual(updated.responseModels, { "application/json": "Empty" });
  await deleteMethodResponse(db, ADMIN, { projectId: PROJECT, apiId: API, methodId: "m1", statusCode: "200", expectedVersion: 2 });
});

test("S06: gateway responses upsert per type with template checks and reset", async () => {
  const db = fakeDb();
  const types = listResponseTypes([]);
  assert.equal(types.length, 21);
  assert.ok(types.every((entry) => entry.customized === false));
  assert.ok(types.find((entry) => entry.type === "THROTTLED")?.defaultStatus === 429);
  await assert.rejects(
    putGatewayResponse(db, ADMIN, { projectId: PROJECT, apiId: API, responseType: "NOPE", input: {} }),
    (error) => error instanceof HttpError && error.status === 422,
  );
  await assert.rejects(
    putGatewayResponse(db, ADMIN, {
      projectId: PROJECT,
      apiId: API,
      responseType: "THROTTLED",
      input: { responseTemplates: { "application/json": "#if($a) broken" } },
    }),
    (error) => error instanceof HttpError && error.status === 422,
  );
  const created = await putGatewayResponse(db, ADMIN, {
    projectId: PROJECT,
    apiId: API,
    responseType: "THROTTLED",
    input: {
      statusCode: "429",
      responseParameters: { "gatewayresponse.header.X-Retry": "'yes'" },
      responseTemplates: { "application/json": '{"message": $context.error.messageString}' },
    },
  });
  assert.equal(created.responseType, "THROTTLED");
  assert.equal(listResponseTypes([created]).find((entry) => entry.type === "THROTTLED")?.customized, true);
  const read = await getGatewayResponse(db, MEMBER, { projectId: PROJECT, apiId: API, responseType: "THROTTLED" });
  assert.equal(read.statusCode, "429");
  const updated = await putGatewayResponse(db, ADMIN, {
    projectId: PROJECT,
    apiId: API,
    responseType: "THROTTLED",
    input: { statusCode: null, responseParameters: {}, responseTemplates: {} },
    expectedVersion: 1,
  });
  assert.equal(updated.version, 2);
  const reset = await resetGatewayResponse(db, ADMIN, { projectId: PROJECT, apiId: API, responseType: "THROTTLED" });
  assert.equal(reset.reset, true);
  await assert.rejects(
    getGatewayResponse(db, MEMBER, { projectId: PROJECT, apiId: API, responseType: "THROTTLED" }),
    (error) => error instanceof HttpError && error.status === 404,
  );
});
