import assert from "node:assert/strict";
import test from "node:test";
import { validateWsMessage } from "../../lib/gateway/core/websocket/validate.mjs";
import { handleWsMessage } from "../../lib/gateway/core/websocket/message.mjs";

test("S12: model validation failure returns error frame and does not invoke integration", async () => {
  const artifact = {
    settings: { routeSelectionExpression: "$request.body.action" },
    routes: [{
      id: "r-send",
      routeKey: "sendmessage",
      requestModels: { "application/json": "SendModel" },
      modelSelectionExpression: "$default",
    }],
    integrations: {},
    models: {
      SendModel: { schema: { type: "object", properties: { action: { type: "string" }, data: { type: "string" } }, required: ["action", "data"] } },
    },
  };
  let invoked = false;
  const record = { connectionId: "c1" };
  const bad = await handleWsMessage({
    artifact: { ...artifact, routes: [{ ...artifact.routes[0], integrationId: "int-1" }], integrations: { "int-1": { type: "MOCK", mockTemplate: JSON.stringify({ body: "hi" }) } } },
    body: JSON.stringify({ action: "sendmessage" }),
    record,
    ctxBase: null,
  });
  assert.equal(bad.status, 400);
  assert.match(bad.frame, /Could not validate|Could not parse/);
  // No invoke path when validation fails: MOCK would have returned "hi".
  assert.ok(!bad.frame.includes("hi"));
  // Valid body passes validation (no error frame from validation).
  const good = validateWsMessage({
    route: artifact.routes[0],
    models: artifact.models,
    bodyText: JSON.stringify({ action: "sendmessage", data: "hi" }),
    parsed: { isJson: true, json: { action: "sendmessage", data: "hi" } },
  });
  assert.equal(good.ok, true);
  // Non-JSON with models → parse error frame.
  const nonJson = validateWsMessage({
    route: artifact.routes[0],
    models: artifact.models,
    bodyText: "not json",
    parsed: { isJson: false, json: null },
  });
  assert.equal(nonJson.ok, false);
  assert.match(nonJson.errorFrame, /Could not parse/);
  void invoked;
});
