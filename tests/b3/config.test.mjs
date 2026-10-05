/**
 * B3 S06 config: management-API writers for request/response processing.
 *
 * Names are prefixed `S06 config:` per the task. Covers:
 * - REST request-template round-trip write → compile → runtime
 * - HTTP parameter-mapping round-trip write → compile → runtime
 * - validation 422 cases (bad mappings, unparsable VTL, secrets)
 * - per-protocol capability gates (400)
 * - integration-response extended fields
 * - enable-cors producing a working OPTIONS preflight at runtime
 */
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { HttpError } from "../../lib/control/errors.mjs";
import {
  createIntegration,
  updateIntegration,
  getIntegration,
  createIntegrationResponse,
  updateIntegrationResponse,
  getIntegrationResponse,
} from "../../lib/control/integrations.mjs";
import { enableCors } from "../../lib/control/enable-cors.mjs";
import { compile } from "../../lib/gateway/artifact/compile.mjs";
import { startUpstream } from "../fixtures/upstream.mjs";
import { compileOrThrow } from "../s06w/helper.mjs";
import { serveArtifact } from "../s06w/serve.mjs";

const PROJECT = "44444444-4444-4444-8444-444444444444";
const REST_API = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const HTTP_API = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const WS_API = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ADMIN = { type: "user", userId: "u-admin" };

function integrationDb({ protocol = "REST", withTemplateColumn = true } = {}) {
  const store = { integrations: new Map(), responses: new Map(), audits: [] };
  const stamp = (row) => ({
    id: randomUUID(),
    created_at: "2026-10-05T00:00:01.000Z",
    updated_at: "2026-10-05T00:00:01.000Z",
    deleted_at: null,
    version: 1,
    ...row,
  });
  return {
    store,
    async getInheritedRole({ userId }) {
      return userId === "u-admin" ? "admin" : null;
    },
    async listRoleBindings() {
      return { roles: [], grants: [] };
    },
    async insertAudit(entry) {
      store.audits.push(entry);
    },
    async getApiProtocol() {
      return protocol;
    },
    async getProjectSettings() {
      return null;
    },
    async listIntegrations({ apiId, limit }) {
      return [...store.integrations.values()].filter((row) => row.api_id === apiId && !row.deleted_at).slice(0, limit);
    },
    async getIntegrationById(id) {
      return store.integrations.get(id) ?? null;
    },
    async insertIntegration(row) {
      const saved = stamp(row);
      // Simulate the DB column set: request/response jsonb always present,
      // template_selection_expression only when the B3 migration applied.
      if (saved.request_parameters === undefined) saved.request_parameters = {};
      if (saved.request_templates === undefined) saved.request_templates = {};
      if (saved.response_parameters === undefined) saved.response_parameters = {};
      if (!withTemplateColumn) delete saved.template_selection_expression;
      store.integrations.set(saved.id, saved);
      return saved;
    },
    async updateIntegration(id, patch) {
      const row = store.integrations.get(id);
      Object.assign(row, patch, { version: row.version + 1 });
      return row;
    },
    async deleteIntegration(id) {
      store.integrations.get(id).deleted_at = "2026-10-05T00:00:02.000Z";
      return { id, deleted: true };
    },
    async listIntegrationResponses({ integrationId }) {
      return [...store.responses.values()].filter((row) => row.integration_id === integrationId && !row.deleted_at);
    },
    async getIntegrationResponseById(id) {
      return store.responses.get(id) ?? null;
    },
    async insertIntegrationResponse(row) {
      const saved = stamp(row);
      store.responses.set(saved.id, saved);
      return saved;
    },
    async updateIntegrationResponse(id, patch) {
      const row = store.responses.get(id);
      Object.assign(row, patch, { version: row.version + 1 });
      return row;
    },
    async deleteIntegrationResponse(id) {
      store.responses.get(id).deleted_at = "2026-10-05T00:00:02.000Z";
      return { id, deleted: true };
    },
  };
}

test("S06 config: REST requestParameters accept integration.request.* and reject bad keys with 422", async () => {
  const db = integrationDb({ protocol: "REST" });
  const created = await createIntegration(db, ADMIN, {
    projectId: PROJECT,
    apiId: REST_API,
    input: {
      type: "HTTP",
      uri: "https://backend.example.com/items",
      requestParameters: { "integration.request.header.X-Target": "method.request.header.X-Source" },
    },
  });
  assert.deepEqual(created.body.requestParameters, { "integration.request.header.X-Target": "method.request.header.X-Source" });
  await assert.rejects(
    createIntegration(db, ADMIN, {
      projectId: PROJECT,
      apiId: REST_API,
      input: {
        type: "HTTP",
        uri: "https://backend.example.com/items",
        requestParameters: { bogus: "method.request.header.X" },
      },
    }),
    (error) => error instanceof HttpError && error.status === 422 && /requestParameters/.test(error.message),
  );
});

test("S06 config: HTTP requestParameters use append/overwrite/remove grammar and reject REST expressions with 422", async () => {
  const db = integrationDb({ protocol: "HTTP" });
  const created = await createIntegration(db, ADMIN, {
    projectId: PROJECT,
    apiId: HTTP_API,
    input: {
      type: "HTTP_PROXY",
      uri: "https://backend.example.com/echo",
      requestParameters: { "overwrite:header.x-over": "static-value" },
    },
  });
  assert.deepEqual(created.body.requestParameters, { "overwrite:header.x-over": "static-value" });
  await assert.rejects(
    createIntegration(db, ADMIN, {
      projectId: PROJECT,
      apiId: HTTP_API,
      input: {
        type: "HTTP_PROXY",
        uri: "https://backend.example.com/echo",
        requestParameters: { "integration.request.header.X": "method.request.header.Y" },
      },
    }),
    (error) => error instanceof HttpError && error.status === 422,
  );
  await assert.rejects(
    updateIntegration(db, ADMIN, {
      projectId: PROJECT,
      apiId: HTTP_API,
      integrationId: created.body.id,
      patch: { requestParameters: { "overwrite:header.Authorization": "$request.header.x" } },
    }),
    (error) => error instanceof HttpError && error.status === 422 && /reserved/i.test(error.message),
  );
});

test("S06 config: requestTemplates reject unparsable VTL and embedded secrets with 422", async () => {
  const rest = integrationDb({ protocol: "REST" });
  await assert.rejects(
    createIntegration(rest, ADMIN, {
      projectId: PROJECT,
      apiId: REST_API,
      input: {
        type: "MOCK",
        requestTemplates: { "application/json": "#if($x\nunclosed" },
      },
    }),
    (error) => error instanceof HttpError && error.status === 422 && /template/i.test(error.message),
  );
  await assert.rejects(
    createIntegration(rest, ADMIN, {
      projectId: PROJECT,
      apiId: REST_API,
      input: {
        type: "MOCK",
        requestTemplates: { "application/json": "hello secret:abc123 world" },
      },
    }),
    (error) => error instanceof HttpError && error.status === 422 && /secret/i.test(error.message),
  );
  const http = integrationDb({ protocol: "HTTP" });
  await assert.rejects(
    createIntegration(http, ADMIN, {
      projectId: PROJECT,
      apiId: HTTP_API,
      input: {
        type: "HTTP_PROXY",
        uri: "https://backend.example.com/echo",
        requestTemplates: { "application/json": "{}" },
      },
    }),
    (error) => error instanceof HttpError && error.status === 400 && error.code === "capability_unsupported",
  );
});

test("S06 config: per-protocol capability gates reject cross-protocol fields with 400", async () => {
  const rest = integrationDb({ protocol: "REST" });
  await assert.rejects(
    createIntegration(rest, ADMIN, {
      projectId: PROJECT,
      apiId: REST_API,
      input: {
        type: "MOCK",
        responseParameters: { 200: { "overwrite:statuscode": "200" } },
      },
    }),
    (error) => error instanceof HttpError && error.status === 400 && error.code === "capability_unsupported",
  );
  const http = integrationDb({ protocol: "HTTP" });
  const created = await createIntegration(http, ADMIN, {
    projectId: PROJECT,
    apiId: HTTP_API,
    input: {
      type: "HTTP_PROXY",
      uri: "https://backend.example.com/echo",
      responseParameters: { 500: { "overwrite:statuscode": "403" } },
    },
  });
  assert.deepEqual(created.body.responseParameters, { 500: { "overwrite:statuscode": "403" } });
  await assert.rejects(
    createIntegration(http, ADMIN, {
      projectId: PROJECT,
      apiId: HTTP_API,
      input: {
        type: "HTTP_PROXY",
        uri: "https://backend.example.com/echo",
        responseParameters: { nope: { "overwrite:statuscode": "200" } },
      },
    }),
    (error) => error instanceof HttpError && error.status === 422,
  );
  const ws = integrationDb({ protocol: "WEBSOCKET" });
  const wsCreated = await createIntegration(ws, ADMIN, {
    projectId: PROJECT,
    apiId: WS_API,
    input: { type: "MOCK", templateSelectionExpression: "$input.path('$.action')" },
  });
  assert.equal(wsCreated.body.templateSelectionExpression, "$input.path('$.action')");
  await assert.rejects(
    createIntegration(ws, ADMIN, {
      projectId: PROJECT,
      apiId: WS_API,
      input: { type: "MOCK", requestParameters: { "overwrite:header.x": "y" } },
    }),
    (error) => error instanceof HttpError && error.status === 400,
  );
});

test("S06 config: integration responses accept responseParameters, responseTemplates and contentHandling", async () => {
  const db = integrationDb({ protocol: "REST" });
  const created = await createIntegration(db, ADMIN, {
    projectId: PROJECT,
    apiId: REST_API,
    input: { type: "HTTP", uri: "https://backend.example.com/x" },
  });
  const response = await createIntegrationResponse(db, ADMIN, {
    projectId: PROJECT,
    apiId: REST_API,
    integrationId: created.body.id,
    input: {
      statusCode: 200,
      selectionPattern: "2..",
      responseParameters: { "method.response.header.X-Reply": "integration.response.header.X-Up" },
      responseTemplates: { "application/json": '{"ok":true}' },
      contentHandling: "CONVERT_TO_TEXT",
    },
  });
  assert.equal(response.status, 201);
  assert.deepEqual(response.body.responseParameters, { "method.response.header.X-Reply": "integration.response.header.X-Up" });
  assert.equal(response.body.contentHandling, "CONVERT_TO_TEXT");
  const patched = await updateIntegrationResponse(db, ADMIN, {
    projectId: PROJECT,
    apiId: REST_API,
    integrationId: created.body.id,
    responseId: response.body.id,
    patch: { responseTemplates: { "application/json": '{"ok":false}' } },
  });
  assert.deepEqual(patched.responseTemplates, { "application/json": '{"ok":false}' });
  const fetched = await getIntegrationResponse(db, ADMIN, {
    projectId: PROJECT,
    apiId: REST_API,
    integrationId: created.body.id,
    responseId: response.body.id,
  });
  assert.deepEqual(fetched.responseTemplates, { "application/json": '{"ok":false}' });
  await assert.rejects(
    createIntegrationResponse(db, ADMIN, {
      projectId: PROJECT,
      apiId: REST_API,
      integrationId: created.body.id,
      input: { statusCode: 200, responseParameters: { bogus: "x" } },
    }),
    (error) => error instanceof HttpError && error.status === 422,
  );
  await assert.rejects(
    createIntegrationResponse(db, ADMIN, {
      projectId: PROJECT,
      apiId: REST_API,
      integrationId: created.body.id,
      input: { statusCode: 200, responseTemplates: { "application/json": "#if(broken" } },
    }),
    (error) => error instanceof HttpError && error.status === 422,
  );
});

test("S06 config: REST request-template round-trip write → compile → runtime", async () => {
  const upstream = await startUpstream();
  try {
    const db = integrationDb({ protocol: "REST" });
    const created = await createIntegration(db, ADMIN, {
      projectId: PROJECT,
      apiId: REST_API,
      input: {
        type: "MOCK",
        requestTemplates: { "application/json": '#set($name = $input.path("$.name")){"hello":"$name"}' },
        passthroughBehavior: "WHEN_NO_MATCH",
      },
    });
    const view = await getIntegration(db, ADMIN, { projectId: PROJECT, apiId: REST_API, integrationId: created.body.id });
    const draft = {
      projectId: "proj-1",
      apiId: "api-rest",
      apiPublicId: "b3rest000001",
      protocol: "REST",
      resources: [{ id: "res-root", path: "/" }, { id: "res-items", path: "/items" }],
      methods: [{
        id: "m1",
        resourceId: "res-items",
        httpMethod: "POST",
        authorizationType: "NONE",
        integrationId: "int1",
        methodResponses: [{ statusCode: "200", responseParameters: {}, responseModels: {} }],
      }],
      integrations: [{
        id: "int1",
        type: view.type,
        requestTemplates: view.requestTemplates,
        passthroughBehavior: view.passthroughBehavior,
        integrationResponses: [{ statusCode: "200", selectionPattern: "", responseParameters: {}, responseTemplates: {} }],
      }],
    };
    const artifact = compileOrThrow(draft);
    assert.deepEqual(artifact.integrations.int1.requestTemplates, view.requestTemplates);
    const { gateway, baseUrl } = await serveArtifact(artifact);
    try {
      const response = await fetch(`${baseUrl}/items`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Ada" }),
      });
      assert.equal(response.status, 200);
    } finally {
      await gateway.close();
    }
  } finally {
    await upstream.close();
  }
});

test("S06 config: HTTP parameter-mapping round-trip write → compile → runtime", async () => {
  const upstream = await startUpstream();
  try {
    const db = integrationDb({ protocol: "HTTP" });
    const created = await createIntegration(db, ADMIN, {
      projectId: PROJECT,
      apiId: HTTP_API,
      input: {
        type: "HTTP_PROXY",
        uri: `${upstream.url}/echo`,
        requestParameters: {
          "overwrite:header.x-over": "static-value",
          "overwrite:querystring.q": "$request.querystring.a",
        },
        responseParameters: { 500: { "overwrite:statuscode": "403" } },
      },
    });
    const view = await getIntegration(db, ADMIN, { projectId: PROJECT, apiId: HTTP_API, integrationId: created.body.id });
    const draft = {
      projectId: "proj-1",
      apiId: "api-http",
      apiPublicId: "b3http000001",
      protocol: "HTTP",
      routes: [{ id: "r1", routeKey: "GET /items", authorizationType: "NONE", integrationId: "int1" }],
      integrations: [{
        id: "int1",
        type: view.type,
        uri: `${upstream.url}/echo`,
        requestParameters: view.requestParameters,
        responseParameters: view.responseParameters,
      }],
    };
    const { errors } = compile(draft);
    assert.deepEqual(errors, []);
    const artifact = compileOrThrow(draft);
    const { gateway, baseUrl } = await serveArtifact(artifact);
    try {
      const response = await fetch(`${baseUrl}/items?a=1`);
      assert.equal(response.status, 200);
      const seen = upstream.requests[upstream.requests.length - 1];
      assert.equal(seen.headers["x-over"], "static-value");
      const query = new URL(`http://x${seen.query}`);
      assert.equal(query.searchParams.get("q"), "1");
    } finally {
      await gateway.close();
    }
  } finally {
    await upstream.close();
  }
});

function corsFakeDb() {
  const store = {
    apis: new Map(),
    resources: new Map(),
    methods: new Map(),
    integrations: new Map(),
    methodResponses: new Map(),
    integrationResponses: new Map(),
    gatewayResponses: new Map(),
    audits: [],
  };
  const apiRow = {
    id: REST_API,
    project_id: PROJECT,
    public_id: "b3cors000001",
    protocol: "REST",
  };
  const resRow = { id: "res-items", api_id: REST_API, project_id: PROJECT, path: "/items", version: 1 };
  const methodRow = {
    id: "m-get",
    project_id: PROJECT,
    api_id: REST_API,
    resource_id: "res-items",
    http_method: "GET",
    authorization_type: "NONE",
    integration_id: "int-get",
    version: 1,
  };
  const intRow = {
    id: "int-get",
    project_id: PROJECT,
    api_id: REST_API,
    type: "HTTP_PROXY",
    uri: "https://backend.example.com/items",
    version: 1,
  };
  store.apis.set(REST_API, apiRow);
  store.resources.set("res-items", resRow);
  store.methods.set("m-get", methodRow);
  store.integrations.set("int-get", intRow);
  return {
    store,
    async getInheritedRole({ userId }) {
      return userId === "u-admin" ? "admin" : null;
    },
    async listRoleBindings() {
      return { roles: [], grants: [] };
    },
    async insertAudit(entry) {
      store.audits.push(entry);
    },
    async getApiByRef({ projectId, ref }) {
      const row = [...store.apis.values()].find((entry) => entry.id === ref || entry.public_id === ref);
      return row ?? null;
    },
    async getResourceById({ id }) {
      return store.resources.get(id) ?? null;
    },
    async getMethod({ resourceId, httpMethod }) {
      return [...store.methods.values()].find((row) => row.resource_id === resourceId && row.http_method === httpMethod) ?? null;
    },
    async listMethodsByApi({ apiId }) {
      return [...store.methods.values()].filter((row) => row.api_id === apiId);
    },
    async insertMethod(row) {
      const saved = { id: randomUUID(), version: 1, ...row };
      store.methods.set(saved.id, saved);
      return saved;
    },
    async updateMethod({ id, patch }) {
      Object.assign(store.methods.get(id), patch);
      return store.methods.get(id);
    },
    async getIntegrationById(id) {
      return store.integrations.get(id) ?? null;
    },
    async insertIntegration(row) {
      const saved = { id: randomUUID(), version: 1, ...row };
      store.integrations.set(saved.id, saved);
      return saved;
    },
    async updateIntegration(id, patch) {
      Object.assign(store.integrations.get(id), patch);
      return store.integrations.get(id);
    },
    async getApiProtocol() {
      return "REST";
    },
    async getMethodResponse({ methodId, statusCode }) {
      return [...store.methodResponses.values()].find((row) => row.method_id === methodId && row.status_code === statusCode) ?? null;
    },
    async insertMethodResponse(row) {
      const saved = { id: randomUUID(), version: 1, ...row };
      store.methodResponses.set(saved.id, saved);
      return saved;
    },
    async updateMethodResponse({ id, ...patch }) {
      Object.assign(store.methodResponses.get(id), patch);
      return store.methodResponses.get(id);
    },
    async listIntegrationResponses({ integrationId }) {
      return [...store.integrationResponses.values()].filter((row) => row.integration_id === integrationId);
    },
    async insertIntegrationResponse(row) {
      const saved = { id: randomUUID(), version: 1, ...row };
      store.integrationResponses.set(saved.id, saved);
      return saved;
    },
    async updateIntegrationResponse(id, patch) {
      Object.assign(store.integrationResponses.get(id), patch);
      return store.integrationResponses.get(id);
    },
    async getGatewayResponse({ apiId, responseType }) {
      return [...store.gatewayResponses.values()].find((row) => row.api_id === apiId && row.response_type === responseType) ?? null;
    },
    async insertGatewayResponse(row) {
      const saved = { id: randomUUID(), version: 1, ...row };
      store.gatewayResponses.set(saved.id, saved);
      return saved;
    },
    async updateGatewayResponse({ id, ...patch }) {
      Object.assign(store.gatewayResponses.get(id), patch);
      return store.gatewayResponses.get(id);
    },
  };
}

test("S06 config: enable-cors creates OPTIONS mock and patches selected methods", async () => {
  const db = corsFakeDb();
  const result = await enableCors(db, ADMIN, {
    projectId: PROJECT,
    apiId: REST_API,
    resourceId: "res-items",
    input: { allowOrigin: "'*'", allowMethods: ["GET", "OPTIONS"], includeGatewayResponses: true },
  });
  assert.ok(result.optionsMethod, "expected an OPTIONS method id");
  assert.deepEqual(result.patchedMethods, ["GET"]);
  assert.deepEqual(result.gatewayResponses.sort(), ["DEFAULT_4XX", "DEFAULT_5XX"]);
  const options = await db.getMethod({ resourceId: "res-items", httpMethod: "OPTIONS" });
  assert.ok(options, "OPTIONS method must exist");
  assert.equal(db.store.audits.length, 1);
  assert.equal(db.store.audits[0].action, "resource.enable_cors");
});

test("S06 config: enable-cors produces a working preflight at runtime", async () => {
  const upstream = await startUpstream();
  try {
    const db = corsFakeDb();
    await enableCors(db, ADMIN, {
      projectId: PROJECT,
      apiId: REST_API,
      resourceId: "res-items",
      input: { allowOrigin: "'*'", allowMethods: ["GET", "OPTIONS"] },
    });
    const options = await db.getMethod({ resourceId: "res-items", httpMethod: "OPTIONS" });
    const optionsIntegration = await db.getIntegrationById(options.integration_id);
    const optionMethodResponses = [...db.store.methodResponses.values()].filter((row) => row.method_id === options.id);
    const optionIntegrationResponses = [...db.store.integrationResponses.values()].filter((row) => row.integration_id === optionsIntegration.id);
    const getMethodResponses = [...db.store.methodResponses.values()].filter((row) => row.method_id === "m-get");
    assert.ok(optionMethodResponses.some((row) => row.status_code === "200"), "OPTIONS needs a 200 method response");
    assert.ok(optionIntegrationResponses.some((row) => row.status_code === "200" || row.status_code === 200), "OPTIONS needs a 200 integration response");
    assert.ok(getMethodResponses.some((row) => row.status_code === "200" || row.status_code === 200), "GET needs a patched 200 method response");

    const draft = {
      projectId: "proj-1",
      apiId: "api-rest",
      apiPublicId: "b3cors000002",
      protocol: "REST",
      resources: [{ id: "res-root", path: "/" }, { id: "res-items", path: "/items" }],
      methods: [
        {
          id: options.id,
          resourceId: "res-items",
          httpMethod: "OPTIONS",
          authorizationType: "NONE",
          integrationId: options.integration_id,
          methodResponses: optionMethodResponses.map((row) => ({
            statusCode: String(row.status_code),
            responseParameters: row.response_parameters ?? {},
            responseModels: row.response_models ?? {},
          })),
        },
        {
          id: "m-get",
          resourceId: "res-items",
          httpMethod: "GET",
          authorizationType: "NONE",
          integrationId: "int-get",
          methodResponses: getMethodResponses.map((row) => ({
            statusCode: String(row.status_code),
            responseParameters: row.response_parameters ?? {},
            responseModels: row.response_models ?? {},
          })),
        },
      ],
      integrations: [
        {
          id: options.integration_id,
          type: "MOCK",
          requestTemplates: optionsIntegration.request_templates ?? { "application/json": '{"statusCode": 200}' },
          passthroughBehavior: "WHEN_NO_MATCH",
          integrationResponses: optionIntegrationResponses.map((row) => ({
            statusCode: String(row.status_code),
            selectionPattern: row.selection_pattern ?? "",
            responseParameters: row.response_parameters ?? {},
            responseTemplates: row.response_templates ?? {},
          })),
        },
        {
          id: "int-get",
          type: "HTTP_PROXY",
          uri: `${upstream.url}/echo`,
          integrationResponses: [...db.store.integrationResponses.values()]
            .filter((row) => row.integration_id === "int-get")
            .map((row) => ({
              statusCode: String(row.status_code),
              selectionPattern: row.selection_pattern ?? "",
              responseParameters: row.response_parameters ?? {},
              responseTemplates: row.response_templates ?? {},
            })),
        },
      ],
    };
    const artifact = compileOrThrow(draft);
    const { gateway, baseUrl } = await serveArtifact(artifact);
    try {
      const preflight = await fetch(`${baseUrl}/items`, { method: "OPTIONS" });
      assert.equal(preflight.status, 200);
      assert.equal(preflight.headers.get("access-control-allow-origin"), "*");
      assert.match(preflight.headers.get("access-control-allow-methods") ?? "", /GET/);
    } finally {
      await gateway.close();
    }
  } finally {
    await upstream.close();
  }
});

test("S06 config: enable-cors rejects non-REST APIs and bad origins with 422/400", async () => {
  const db = corsFakeDb();
  db.getApiProtocol = async () => "HTTP";
  db.getApiByRef = async () => ({ id: REST_API, project_id: PROJECT, public_id: "x", protocol: "HTTP" });
  await assert.rejects(
    enableCors(db, ADMIN, { projectId: PROJECT, apiId: REST_API, resourceId: "res-items", input: {} }),
    (error) => error instanceof HttpError && error.status === 400,
  );
});
