import assert from "node:assert/strict";
import test from "node:test";
import { selectRoute, evaluateSelection, parseMessageBody, forbiddenFrame } from "../../lib/gateway/core/websocket/selection.mjs";
import { runPipeline, runPhases } from "../../lib/gateway/core/index.mjs";
import { buildContext } from "../../lib/gateway/core/context.mjs";

test("S12: route selection — JSON action match, unknown action → $default, non-JSON → $default, no $default → Forbidden error frame", () => {
  const artifact = {
    settings: { routeSelectionExpression: "$request.body.action" },
    routes: [{ routeKey: "$default" }, { routeKey: "sendmessage" }],
  };
  assert.equal(selectRoute(artifact, JSON.stringify({ action: "sendmessage" })).routeKey, "sendmessage");
  assert.equal(selectRoute(artifact, JSON.stringify({ action: "nope" })).routeKey, "$default");
  assert.equal(selectRoute(artifact, "not json").routeKey, "$default");
  // `${request.body.action}` style also selects.
  const braced = { settings: { routeSelectionExpression: "${request.body.action}" }, routes: artifact.routes };
  assert.equal(selectRoute(braced, JSON.stringify({ action: "sendmessage" })).routeKey, "sendmessage");
  // No $default → null + Forbidden frame.
  const bare = { settings: { routeSelectionExpression: "$request.body.action" }, routes: [{ routeKey: "sendmessage" }] };
  const outcome = selectRoute(bare, JSON.stringify({ action: "nope" }));
  assert.equal(outcome.routeKey, null);
  const frame = forbiddenFrame({ connectionId: "c1", requestId: "r1" });
  assert.match(frame, /Forbidden/);
  assert.match(frame, /c1/);
  // Prototype-pollution paths never select.
  const evil = evaluateSelection("$request.body.__proto__", parseMessageBody(JSON.stringify({ __proto__: { x: 1 } })));
  assert.equal(evil, null);
});

test("S12: WEBSOCKET pipeline fallback requires upgrade (F3)", async () => {
  const artifact = { protocol: "WEBSOCKET", apiPublicId: "ws12345678", projectId: "p1", settings: {} };
  const plain = new Request("http://localhost/x", { method: "GET" });
  const ctx = buildContext(plain, artifact, {});
  const { runPipeline: run } = await import("../../lib/gateway/core/pipeline.mjs");
  const response = await run(ctx);
  assert.equal(response.status, 400);
  const upgrade = new Request("http://localhost/x", { method: "GET", headers: { upgrade: "websocket" } });
  const ctx2 = buildContext(upgrade, artifact, {});
  const response2 = await run(ctx2);
  assert.equal(response2.status, 403);
});
