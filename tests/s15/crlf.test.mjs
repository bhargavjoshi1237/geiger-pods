/**
 * S15 part 1 (security): CRLF injection via mapped headers.
 *
 * - A static CRLF in a mapped header value must be rejected at config time
 *   (management-service validation).
 * - A runtime-computed CRLF (mapping output containing CR/LF from request
 *   input) must fail the request with 500 `API_CONFIGURATION_ERROR`, never
 *   splitting a response/request line on the wire.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  validateHttpMapping,
  validateRestRequestMapping,
  validateRestResponseMapping,
} from "../../lib/gateway/core/processing/param-mapping.mjs";
import { createIntegration } from "../../lib/control/integrations.mjs";
import { HttpError } from "../../lib/control/errors.mjs";
import { handle } from "../../lib/gateway/core/index.mjs";
import { MemoryKvStore } from "../../lib/gateway/state/memory-kv.mjs";

process.env.PODS_ALLOW_LOOPBACK = "1";

const PROJECT = "proj-s15-crlf";
const ADMIN = { type: "user", userId: "u-admin" };

function controlFakeDb() {
  return {
    async getInheritedRole() { return "admin"; },
    async listRoleBindings() { return { roles: [], grants: [] }; },
    async getApiProtocol() { return "HTTP"; },
    async getProjectSettings() { return null; },
    async insertAudit() {},
    async insertIntegration(row) {
      return { ...row, id: "int-1", version: 1, created_at: new Date().toISOString() };
    },
  };
}

test("S15: CRLF in mapped header value → config rejected; runtime-computed CRLF → 500 API_CONFIGURATION_ERROR", async () => {
  // --- Config time: static CRLF rejected by the validators ----------------
  const http = validateHttpMapping({ "overwrite:header.x-evil": "a\r\nB: c" }, "request");
  assert.ok(http.errors.length > 0, "static CRLF in HTTP mapping must error");

  const httpResp = validateHttpMapping({ "overwrite:header.x-evil": "x\nSet-Cookie: s=1" }, "response");
  assert.ok(httpResp.errors.length > 0, "static LF in HTTP response mapping must error");

  const rest = validateRestRequestMapping({ "integration.request.header.x-evil": "'a\r\nB: c'" });
  assert.ok(rest.errors.length > 0, "static CRLF in REST mapping must error");

  const restResp = validateRestResponseMapping(
    { "method.response.header.x-evil": "'x\r\nSet-Cookie: s=1'" },
    { "method.response.header.x-evil": true },
  );
  assert.ok(restResp.errors.length > 0, "static CRLF in REST response mapping must error");

  // --- Config time: same through the management service -------------------
  await assert.rejects(
    createIntegration(controlFakeDb(), ADMIN, {
      projectId: PROJECT,
      apiId: "api-1",
      input: {
        type: "HTTP_PROXY",
        uri: "https://example.com/echo",
        requestParameters: { "overwrite:header.x-evil": "a\r\nInjected: 1" },
      },
    }),
    (error) => error instanceof HttpError && error.status === 422,
  );

  // --- Runtime: computed CRLF → 500 API_CONFIGURATION_ERROR ---------------
  const artifact = {
    schemaVersion: 1,
    projectId: PROJECT,
    apiId: "api-crlf",
    apiPublicId: "crlf123456",
    protocol: "HTTP",
    stage: "prod",
    settings: {},
    routes: [{
      id: "r1",
      routeKey: "GET /x",
      auth: { type: "NONE" },
      apiKeyRequired: false,
      integrationId: "int1",
    }],
    integrations: {
      int1: {
        id: "int1",
        type: "HTTP_PROXY",
        uri: "http://127.0.0.1:1/echo",
        integration_method: "GET",
        timeout_ms: 1000,
        requestMapping: { "overwrite:header.x-evil": "${request.querystring.next}" },
      },
    },
    authorizers: {},
    models: {},
  };
  const ports = {
    kv: new MemoryKvStore({}),
    events: { emit() {} },
    secrets: { async resolve() { throw new Error("no secrets"); } },
  };
  const response = await handle(
    new Request("http://gw.test/x?next=a%0d%0aB:%20c"),
    artifact,
    ports,
  );
  assert.equal(response.status, 500, `runtime CRLF must be 500, got ${response.status}`);
  assert.equal(response.headers.get("x-pods-error-type"), "API_CONFIGURATION_ERROR");
});
