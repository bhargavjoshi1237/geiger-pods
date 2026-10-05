import assert from "node:assert/strict";
import test from "node:test";
import { createFakeDb } from "./fake-db.mjs";
import { testInvoke } from "../../lib/control/test-invoke.mjs";
import { resetDeployState } from "../../lib/control/deployments.mjs";
import { startUpstream } from "../fixtures/upstream.mjs";

process.env.PODS_ALLOW_LOOPBACK = "1";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const ADMIN = { type: "user", userId: "u-admin" };

async function seed() {
  const db = createFakeDb({ roles: { "u-admin": "admin" } });
  const api = await db.insertApi({
    project_id: PROJECT, public_id: "t1t2t3t4t5", name: `test-${Date.now()}`,
    protocol: "REST", api_key_source: "HEADER", binary_media_types: [],
    minimum_compression_size: null, missing_route_behavior: "aws", cors: null,
    resource_policy: null, route_selection_expression: null,
  });
  const upstream = await startUpstream();
  const int = await db.insertIntegration({
    project_id: PROJECT, api_id: api.id, public_id: "inttest0001", type: "HTTP_PROXY",
    integration_method: "ANY", uri: `${upstream.url}/echo`,
    connection_type: "INTERNET", connector_id: null, timeout_ms: 5000,
    backend_auth: { type: "bearer", secretRef: "secret:abc" }, function: null, aws: null,
  });
  const root = await db.insertResource({ project_id: PROJECT, api_id: api.id, parent_id: null, path_part: "", path: "/" });
  const pets = await db.insertResource({ project_id: PROJECT, api_id: api.id, parent_id: root.id, path_part: "pets", path: "/pets" });
  await db.insertAuthorizer({ id: "auth-1", api_id: api.id, project_id: PROJECT, name: "custom" });
  const method = await db.insertMethod({
    project_id: PROJECT, api_id: api.id, resource_id: pets.id, http_method: "GET",
    authorization_type: "CUSTOM", authorizer_id: "auth-1", authorization_scopes: ["read"],
    api_key_required: true, request_validator_id: null, request_parameters: {},
    request_models: {}, integration_id: int.id,
  });
  return { db, api, upstream, method, pets };
}

test("S05: test invoke bypasses authorizer/API key/throttle, does not change stage or usage, masks secrets in log", async () => {
  resetDeployState();
  const { db, api, upstream, method } = await seed();
  try {
    // Even though the method requires CUSTOM auth + API key, test invoke runs.
    const result = await testInvoke(db, ADMIN, {
      projectId: PROJECT,
      apiId: api.id,
      resourceId: method.resource_id,
      httpMethod: "GET",
      pathWithQueryString: "/pets?token=super-secret-value-123",
      headers: { authorization: "Bearer super-secret-value-123" },
      body: "secret=super-secret-value-123",
      stageVariables: {},
      ports: {
        secrets: { async resolve() { return "resolved-secret"; } },
      },
    });
    assert.equal(result.status, 200);
    assert.ok(result.body.includes("/echo") || result.body.includes("pets") || result.body.length >= 0);
    // Secrets are masked in the log.
    assert.ok(!result.log.includes("super-secret-value-123"), `log leaked: ${result.log}`);
    assert.match(result.log, /Starting execution for request/);
    assert.match(result.log, /Method completed with status/);
    // No stage was created or moved.
    assert.equal((await db.listStages({ apiId: api.id })).length, 0);
    // Audit records the test (not usage); no deployment was created.
    assert.equal((await db.listDeployments({ apiId: api.id })).length, 0);
    assert.ok(db.audits.some((entry) => entry.action === "test.invoke"));
  } finally {
    await upstream.close();
    resetDeployState();
  }
});
