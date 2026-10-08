/**
 * F38 [runtime] (S15 part 2): control-plane `@connections` gateway client.
 *
 * `manageConnection` with a `gateway` config (no stub `sender`) drives a
 * live gateway: POST delivers to the socket, GET returns connection info,
 * DELETE disconnects (204 + 1000), unknown ids 410. This is the path the
 * prod management route uses when `PODS_GATEWAY_URL` + the service
 * credential are configured, so UI/CLI work without a stub.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { WebSocket } from "ws";

import { manageConnection } from "../../lib/control/websocket.mjs";
import { wsArtifact, startWsGateway } from "../s12/helper.mjs";

const ACCESS = "AKIDF3800001";
const SECRET = "f38-secret-000000000000000000000001";

function signingPorts() {
  return {
    signingCredentials: {
      async resolve(accessKeyId) {
        if (accessKeyId !== ACCESS) return null;
        return { secretAccessKey: SECRET, status: "ACTIVE", projectId: "proj-f38" };
      },
    },
    signingPolicies: {
      async list(accessKeyId) {
        if (accessKeyId !== ACCESS) return [];
        return [{
          Version: "2012-10-17",
          Statement: [{ Effect: "Allow", Action: "execute-api:ManageConnections", Resource: "*" }],
        }];
      },
    },
  };
}

function controlDbFor(api) {
  return {
    async getApiByRef() { return api; },
    async getInheritedRole() { return "owner"; },
    async listRoleBindings() { return { roles: [], grants: [] }; },
  };
}

function actor() {
  return { userId: "user-f38", type: "user" };
}

test("F38 [runtime]: manageConnection via the gateway client drives a live connection", async (t) => {
  const artifact = {
    ...wsArtifact({ apiPublicId: "wsf3800001" }),
    projectId: "proj-f38",
    routes: [
      { id: "r-connect", routeKey: "$connect", auth: { type: "NONE" }, apiKeyRequired: false, integrationId: null },
      { id: "r-default", routeKey: "$default", auth: { type: "NONE" }, apiKeyRequired: false, integrationId: null },
    ],
  };
  const { gateway, port } = await startWsGateway(artifact, { ports: signingPorts() });
  t.after(() => gateway.close());
  const ws = new WebSocket(`ws://127.0.0.1:${port}/${artifact.apiPublicId}/prod`);
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
    setTimeout(() => reject(new Error("open timeout")), 5000);
  });
  t.after(() => {
    try { ws.terminate(); } catch { /* best-effort */ }
  });
  const connectionId = [...gateway.wsManager.connections.keys()][0];
  assert.ok(connectionId);

  const api = {
    id: "api-f38",
    public_id: artifact.apiPublicId,
    publicId: artifact.apiPublicId,
    project_id: "proj-f38",
    protocol: "WEBSOCKET",
  };
  const db = controlDbFor(api);

  const gatewayConfig = {
    gatewayUrl: `http://127.0.0.1:${port}`,
    apiPublicId: artifact.apiPublicId,
    stage: "prod",
    accessKeyId: ACCESS,
    secretAccessKey: SECRET,
  };
  const base = { projectId: "proj-f38", apiId: api.id, stage: "prod", connectionId, gateway: gatewayConfig };

  // GET via the control plane → live gateway info.
  const info = await manageConnection(db, actor(), { ...base, method: "GET" });
  assert.ok(info?.body?.connectedAt ?? info?.connectedAt, "GET must return connection info");

  // POST via the control plane → socket receives.
  const incoming = new Promise((resolve, reject) => {
    ws.once("message", (data) => resolve(String(data)));
    setTimeout(() => reject(new Error("delivery timeout")), 5000);
  });
  await manageConnection(db, actor(), {
    ...base,
    method: "POST",
    body: Buffer.from("hello-via-control"),
    contentType: "text/plain",
  });
  assert.equal(await incoming, "hello-via-control");

  // Unknown id → 410 through the client (not a stub).
  await assert.rejects(
    manageConnection(db, actor(), { ...base, connectionId: "does-not-exist", method: "GET" }),
    (error) => error?.status === 410,
  );

  // DELETE via the control plane → 204 + socket closed.
  const closed = new Promise((resolve, reject) => {
    ws.once("close", (code) => resolve(code));
    setTimeout(() => reject(new Error("delete close timeout")), 5000);
  });
  await manageConnection(db, actor(), { ...base, method: "DELETE" });
  assert.equal(await closed, 1000);
});
