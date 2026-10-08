import assert from "node:assert/strict";
import test from "node:test";
import { compile } from "../../lib/gateway/artifact/compile.mjs";
import { MemoryKvStore } from "../../lib/gateway/state/memory-kv.mjs";
import {
  buildMcpInputSchema,
  handleMcpRequest,
  listMcpTools,
  sanitizeToolName,
} from "../../lib/gateway/distribution/mcp.mjs";

function petArtifact() {
  const draft = {
    projectId: "proj-mcp",
    apiId: "api-mcp",
    apiPublicId: "mcp1234567",
    protocol: "REST",
    settings: {},
    resources: [
      { id: "res-root", path: "/" },
      { id: "res-pets", path: "/pets" },
      { id: "res-pet", path: "/pets/{petId}" },
    ],
    methods: [
      {
        id: "m-list", resourceId: "res-pets", httpMethod: "GET",
        authorizationType: "NONE", authorizerId: null, authorizationScopes: [],
        apiKeyRequired: false, operationName: "listPets",
        requestParameters: { "method.request.querystring.limit": false, "method.request.header.x-version": true },
        requestModels: { "application/json": "Pet" }, integrationId: "int-mock",
      },
      {
        id: "m-get", resourceId: "res-pet", httpMethod: "GET",
        authorizationType: "NONE", authorizerId: null, authorizationScopes: [],
        apiKeyRequired: false, operationName: "",
        requestParameters: {}, requestModels: {}, integrationId: "int-mock",
      },
    ],
    integrations: [{ id: "int-mock", type: "MOCK" }],
    models: [{ name: "Pet", schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } }],
  };
  const { artifact, errors } = compile(draft);
  assert.equal(errors.length, 0, errors[0]?.message);
  return { ...artifact, stage: "prod", stageVariables: {}, deploymentId: "d1" };
}

test("S13E: tools/list derives input schema from params+model; tools/call goes through authorizer and throttling (spy)", async () => {
  const artifact = petArtifact();
  const docsByLocation = new Map([
    ["GET /pets", { description: "List all pets" }],
  ]);

  // tools/list: names, descriptions and input schemas from params + model.
  const tools = listMcpTools(artifact, { allowOperations: null, docsByLocation });
  assert.equal(tools.length, 2);
  const listPets = tools.find((entry) => entry.name === "listPets");
  assert.ok(listPets, "operationName becomes the tool name");
  assert.equal(listPets.description, "List all pets");
  assert.equal(listPets.inputSchema.type, "object");
  assert.ok(listPets.inputSchema.properties.limit, "query param projected");
  assert.ok(listPets.inputSchema.properties["header.x-version"], "header param projected");
  assert.ok(listPets.inputSchema.properties.body, "body model projected");
  assert.ok(listPets.inputSchema.required.includes("header.x-version"));
  assert.equal(sanitizeToolName("GET /pets/{petId}"), "GET_pets_petId");

  const schema = buildMcpInputSchema(
    { requestParameters: { "method.request.path.petId": true }, requestModels: {} },
    {},
  );
  assert.ok(schema.properties["path.petId"]);

  // tools/call: no params → MOCK integration succeeds through the pipeline.
  const kv = new MemoryKvStore({ clock: { now: () => 0 } });
  const ports = { kv, fetch: globalThis.fetch, clock: { now: () => 0 }, log() {}, events: { emit() {} } };
  const listed = await handleMcpRequest({
    artifact, stageConfig: { enabled: true }, docsByLocation,
    body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    headers: {}, ports,
  });
  assert.equal(listed.result.tools.length, 2);

  const called = await handleMcpRequest({
    artifact, stageConfig: { enabled: true }, docsByLocation,
    body: { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "listPets", arguments: {} } },
    headers: {}, ports,
  });
  assert.ok(called.result.content.length > 0);
  assert.equal(called.result.isError ?? false, false);

  // Authorizer spy: a CUSTOM authorizer must run on tools/call. Without the
  // identity header the pipeline 401s; with it the authorizer stub runs once
  // and the MOCK integration succeeds.
  let authorizerCalls = 0;
  const allowOutput = {
    principalId: "agent-1",
    policyDocument: { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "execute-api:Invoke", Resource: "*" }] },
    context: {},
  };
  const authed = {
    ...artifact,
    resources: artifact.resources.map((resource) => ({
      ...resource,
      methods: Object.fromEntries(Object.entries(resource.methods ?? {}).map(([method, entry]) => [
        method,
        method === "GET" && resource.path === "/pets"
          ? { ...entry, auth: { type: "CUSTOM", authorizerId: "c1", scopes: [] } }
          : entry,
      ])),
    })),
    authorizers: {
      c1: {
        id: "c1", name: "agent-auth", type: "TOKEN",
        identitySource: ["method.request.header.Authorization"],
        function: { provider: "webhook", url: "https://auth.example/agent" },
        resultTtlSeconds: 0,
      },
    },
  };
  const authPorts = {
    kv: new MemoryKvStore({ clock: { now: () => 0 } }),
    clock: { now: () => 0 },
    log() {},
    events: { emit() {} },
    fetch: async (url) => {
      if (String(url).startsWith("https://auth.example/")) {
        authorizerCalls += 1;
        return { ok: true, status: 200, text: async () => JSON.stringify(allowOutput) };
      }
      throw new Error(`unexpected fetch ${url}`);
    },
  };
  const denied = await handleMcpRequest({
    artifact: authed, stageConfig: { enabled: true }, docsByLocation,
    body: { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "listPets", arguments: {} } },
    headers: {}, ports: authPorts,
  });
  assert.equal(denied.result.isError, true);
  assert.equal(authorizerCalls, 0, "missing identity short-circuits before invoke");
  const authedCall = await handleMcpRequest({
    artifact: authed, stageConfig: { enabled: true }, docsByLocation,
    body: { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "listPets", arguments: {} } },
    headers: { authorization: "Bearer agent-token" }, ports: authPorts,
  });
  assert.equal(authedCall.result.isError ?? false, false);
  assert.equal(authorizerCalls, 1, "tools/call ran the custom authorizer");

  // Throttling spy: a zero-burst project bucket rejects through the same
  // pipeline path, and the MCP error surfaces THROTTLED.
  const throttleKv = new MemoryKvStore({ clock: { now: () => 0 } });
  const throttlePorts = {
    kv: throttleKv, clock: { now: () => 0 }, log() {}, events: { emit() {} }, fetch: globalThis.fetch,
  };
  const throttled = await handleMcpRequest({
    artifact, stageConfig: { enabled: true }, docsByLocation,
    body: { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "listPets", arguments: {} } },
    headers: {}, ports: throttlePorts,
    usage: { project: { rate: 0, burst: 0 } },
  });
  assert.equal(throttled.result.isError, true);
  assert.match(JSON.stringify(throttled.result), /THROTTLED|Too Many Requests|429/);
});
