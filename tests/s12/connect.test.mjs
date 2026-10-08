import assert from "node:assert/strict";
import test from "node:test";
import { WebSocket } from "ws";
import { wsArtifact, startWsGateway, stubFetch, jsonResponse, usagePorts, hmacFor, PEPPER } from "./helper.mjs";
import { MemoryKvStore } from "../../lib/gateway/state/memory-kv.mjs";
import { createEventSink } from "../../lib/gateway/core/observe/event.mjs";

function upgradeStatus(url, { headers = {} } = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers });
    const timer = setTimeout(() => done("timeout"), 5000);
    if (timer.unref) timer.unref();
    const done = (status) => {
      clearTimeout(timer);
      try {
        ws.terminate();
      } catch {
        // Best-effort.
      }
      resolve(status);
    };
    ws.on("open", () => done(101));
    ws.on("unexpected-response", (_req, res) => done(res.statusCode));
    ws.on("error", () => {});
  });
}

test("S12 [runtime]: connect → $connect function invoked with CONNECT event; non-2xx rejects upgrade with that status", async () => {
  const seen = [];
  const fetch = stubFetch([{
    match: "fn-connect",
    handler: async (_url, init) => {
      seen.push(JSON.parse(String(init.body)));
      return jsonResponse({ statusCode: 200, body: "welcome" });
    },
  }]);
  const artifact = {
    ...wsArtifact({ apiPublicId: "wsconn0001" }),
    routes: [
      { id: "r-connect", routeKey: "$connect", auth: { type: "NONE" }, apiKeyRequired: false, integrationId: "int-connect" },
      { id: "r-default", routeKey: "$default", auth: { type: "NONE" }, apiKeyRequired: false, integrationId: null },
    ],
    integrations: { "int-connect": { type: "FUNCTION_PROXY", function: { provider: "webhook", url: "http://fn.local/fn-connect" } } },
  };
  const { gateway, port } = await startWsGateway(artifact, { ports: { fetch } });
  try {
    const status = await upgradeStatus(`ws://127.0.0.1:${port}/${artifact.apiPublicId}/prod`);
    assert.equal(status, 101);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].requestContext.eventType, "CONNECT");
    assert.equal(seen[0].requestContext.routeKey, "$connect");
    assert.ok(seen[0].requestContext.connectionId);
  } finally {
    await gateway.close();
  }

  // Non-2xx function statusCode rejects the upgrade with that status.
  const fetch403 = stubFetch([{
    match: "fn-connect",
    handler: async () => jsonResponse({ statusCode: 403, body: "no" }),
  }]);
  const artifact403 = {
    ...artifact,
    apiPublicId: "wsconn0002",
    integrations: { "int-connect": { type: "FUNCTION_PROXY", function: { provider: "webhook", url: "http://fn.local/fn-connect" } } },
  };
  const second = await startWsGateway(artifact403, { ports: { fetch: fetch403 } });
  try {
    const status = await upgradeStatus(`ws://127.0.0.1:${second.port}/${artifact403.apiPublicId}/prod`);
    assert.equal(status, 403);
  } finally {
    await second.gateway.close();
  }
});

test("S12 [runtime]: CUSTOM authorizer on $connect with query-string identity source; deny → 403 upgrade response; context available in later MESSAGE events", async () => {
  const messageEvents = [];
  const fetch = stubFetch([
    {
      match: "auth-ws",
      handler: async (_url, init) => {
        const event = JSON.parse(String(init.body));
        const token = event.queryStringParameters?.token ?? event.multiValueQueryStringParameters?.token?.[0] ?? null;
        if (token === "good") {
          return jsonResponse({
            principalId: "alice",
            policyDocument: { Version: "2012-10-17", Statement: [{ Action: "execute-api:Invoke", Effect: "Allow", Resource: "*" }] },
            context: { user: "alice" },
          });
        }
        return jsonResponse({
          principalId: "nobody",
          policyDocument: { Version: "2012-10-17", Statement: [{ Action: "execute-api:Invoke", Effect: "Deny", Resource: "*" }] },
        });
      },
    },
    {
      match: "fn-msg",
      handler: async (_url, init) => {
        messageEvents.push(JSON.parse(String(init.body)));
        return jsonResponse({ statusCode: 200, body: "echo-ok" });
      },
    },
  ]);
  const artifact = {
    ...wsArtifact({ apiPublicId: "wsauth00001" }),
    routes: [
      {
        id: "r-connect", routeKey: "$connect", auth: { type: "CUSTOM", authorizerId: "auth-1" }, apiKeyRequired: false, integrationId: null,
      },
      {
        id: "r-send", routeKey: "sendmessage", auth: { type: "NONE" }, apiKeyRequired: false, integrationId: "int-msg", routeResponseSelectionExpression: "$default",
      },
      { id: "r-default", routeKey: "$default", auth: { type: "NONE" }, apiKeyRequired: false, integrationId: null },
    ],
    integrations: { "int-msg": { type: "FUNCTION_PROXY", function: { provider: "webhook", url: "http://fn.local/fn-msg" } } },
    authorizers: {
      "auth-1": {
        id: "auth-1", type: "REQUEST", identitySource: ["method.request.querystring.token"],
        function: { provider: "webhook", url: "http://auth.local/auth-ws" },
      },
    },
    settings: { routeSelectionExpression: "$request.body.action" },
  };
  const { gateway, port } = await startWsGateway(artifact, { ports: { fetch } });
  try {
    const denied = await upgradeStatus(`ws://127.0.0.1:${port}/${artifact.apiPublicId}/prod?token=bad`);
    assert.equal(denied, 403);
    // Allowed token connects; its authorizer context replays into MESSAGE.
    const ws = new WebSocket(`ws://127.0.0.1:${port}/${artifact.apiPublicId}/prod?token=good`);
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
      setTimeout(() => reject(new Error("open timeout")), 5000);
    });
    const reply = new Promise((resolve, reject) => {
      ws.once("message", (data) => resolve(String(data)));
      setTimeout(() => reject(new Error("message timeout")), 5000);
    });
    ws.send(JSON.stringify({ action: "sendmessage", data: "hi" }));
    const text = await reply;
    assert.equal(text, "echo-ok");
    assert.equal(messageEvents.length, 1);
    assert.equal(messageEvents[0].requestContext.authorizer?.user ?? messageEvents[0].requestContext.authorizer?.principalId, "alice");
    ws.terminate();
  } finally {
    await gateway.close();
  }
});

test("S12 [runtime]: api key required on $connect via apiKeySelectionExpression", async () => {
  const keyValue = "ABCDEFGHIJ1234567890";
  const hmac = hmacFor(keyValue);
  const records = new Map([[hmac, { keyId: "key-1", publicId: "pub-1", enabled: true, plans: [{ planId: "plan-1", apiId: "api-ws", stage: "prod" }] }]]);
  const artifact = {
    ...wsArtifact({ apiPublicId: "wskey000001" }),
    routes: [
      { id: "r-connect", routeKey: "$connect", auth: { type: "NONE" }, apiKeyRequired: true, integrationId: null },
      { id: "r-default", routeKey: "$default", auth: { type: "NONE" }, apiKeyRequired: false, integrationId: null },
    ],
    settings: { routeSelectionExpression: "$request.body.action", apiKeySelectionExpression: "$request.header.x-api-key" },
  };
  const { gateway, port } = await startWsGateway(artifact, { ports: usagePorts({ records }) });
  try {
    const denied = await upgradeStatus(`ws://127.0.0.1:${port}/${artifact.apiPublicId}/prod`);
    assert.equal(denied, 403);
    const allowed = await upgradeStatus(`ws://127.0.0.1:${port}/${artifact.apiPublicId}/prod`, { headers: { "x-api-key": keyValue } });
    assert.equal(allowed, 101);
  } finally {
    await gateway.close();
  }
});
