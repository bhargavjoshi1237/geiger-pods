import assert from "node:assert/strict";
import test from "node:test";
import { compile } from "../../lib/gateway/artifact/compile.mjs";
import { createMemoryLoader } from "../../gateway/loader.mjs";
import { createGatewayServer } from "../../gateway/server.mjs";
import { MemoryKvStore } from "../../lib/gateway/state/memory-kv.mjs";

const ALLOW_OUTPUT = {
  principalId: "agent-1",
  policyDocument: {
    Version: "2012-10-17",
    Statement: [{ Effect: "Allow", Action: "execute-api:Invoke", Resource: "*" }],
  },
  context: {},
};

function authedArtifact({ apiPublicId }) {
  const draft = {
    projectId: "proj-mcp-rt",
    apiId: `api-${apiPublicId}`,
    apiPublicId,
    protocol: "REST",
    resources: [
      { id: "res-root", path: "/" },
      { id: "res-pets", path: "/pets" },
    ],
    methods: [{
      id: "m-list", resourceId: "res-pets", httpMethod: "GET",
      authorizationType: "NONE", authorizerId: null, authorizationScopes: [],
      apiKeyRequired: false, operationName: "listPets",
      requestParameters: {}, requestModels: {}, integrationId: "int-mock",
    }],
    integrations: [{ id: "int-mock", type: "MOCK" }],
    models: [],
  };
  const { artifact, errors } = compile(draft);
  assert.equal(errors.length, 0, errors[0]?.message);
  return {
    ...artifact,
    stage: "prod",
    stageVariables: {},
    deploymentId: "d1",
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
        id: "c1",
        name: "agent-auth",
        type: "TOKEN",
        identitySource: ["method.request.header.Authorization"],
        function: { provider: "webhook", url: "https://auth.example/agent" },
        resultTtlSeconds: 0,
      },
    },
  };
}

function stubFetch() {
  let authorizerCalls = 0;
  const fetch = async (url) => {
    if (String(url).startsWith("https://auth.example/")) {
      authorizerCalls += 1;
      return { ok: true, status: 200, text: async () => JSON.stringify(ALLOW_OUTPUT) };
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  return { fetch, calls: () => authorizerCalls };
}

async function postMcp(base, body, headers = {}) {
  const response = await fetch(base, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

test("S13E [runtime]: _mcp tools/list and tools/call go through the real pipeline", async () => {
  const artifact = authedArtifact({ apiPublicId: "mcprt12345" });
  const loader = createMemoryLoader({
    pathRouting: true,
    stages: new Map([[
      `${artifact.apiPublicId}:prod`,
      { artifact, agentTools: { enabled: true, allowOperations: null, auth: "passthrough" } },
    ]]),
  });
  const stub = stubFetch();
  const gateway = createGatewayServer({
    loader,
    ports: { kv: new MemoryKvStore({}), fetch: stub.fetch, events: { emit() {} } },
  });
  const port = await gateway.start(0);
  try {
    const base = `http://127.0.0.1:${port}/${artifact.apiPublicId}/prod/_mcp`;

    const listed = await postMcp(base, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    assert.equal(listed.status, 200);
    assert.equal(listed.body.result.tools.length, 1);
    assert.equal(listed.body.result.tools[0].name, "listPets");

    // No Authorization header → the CUSTOM authorizer rejects through the
    // real pipeline (webhook never reached) and the call surfaces isError.
    const denied = await postMcp(base, {
      jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "listPets", arguments: {} },
    });
    assert.equal(denied.status, 200);
    assert.equal(denied.body.result.isError, true);
    assert.equal(stub.calls(), 0, "missing identity short-circuits before the webhook");
    assert.match(JSON.stringify(denied.body.result), /401|Unauthorized/i);

    // With the identity header the authorizer runs and MOCK succeeds.
    const authed = await postMcp(base, {
      jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "listPets", arguments: {} },
    }, { authorization: "Bearer agent-token" });
    assert.equal(authed.body.result.isError ?? false, false);
    assert.equal(authed.body.result.status, 200);
    assert.equal(stub.calls(), 1, "tools/call ran the custom authorizer");
  } finally {
    await gateway.close();
  }
});

test("S13E [runtime]: _mcp on a stage with agent tools disabled → 404", async () => {
  const offArtifact = authedArtifact({ apiPublicId: "mcprt67890" });
  const plain = { ...offArtifact, authorizers: {} };
  const loader = createMemoryLoader({
    pathRouting: true,
    stages: new Map([
      [`${offArtifact.apiPublicId}:prod`, {
        artifact: plain,
        agentTools: { enabled: false, allowOperations: null, auth: "passthrough" },
      }],
      [`${offArtifact.apiPublicId}:unstaged`, { artifact: plain }],
    ]),
  });
  const stub = stubFetch();
  const gateway = createGatewayServer({
    loader,
    ports: { kv: new MemoryKvStore({}), fetch: stub.fetch, events: { emit() {} } },
  });
  const port = await gateway.start(0);
  try {
    const disabled = await postMcp(
      `http://127.0.0.1:${port}/${offArtifact.apiPublicId}/prod/_mcp`,
      { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    );
    assert.equal(disabled.status, 404);

    const absent = await postMcp(
      `http://127.0.0.1:${port}/${offArtifact.apiPublicId}/unstaged/_mcp`,
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    );
    assert.equal(absent.status, 404);
  } finally {
    await gateway.close();
  }
});
