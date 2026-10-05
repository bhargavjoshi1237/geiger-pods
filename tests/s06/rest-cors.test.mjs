import assert from "node:assert/strict";
import test from "node:test";

import { buildEnableCorsDraft, getCors, putCors } from "../../lib/control/cors.mjs";
import { HttpError } from "../../lib/control/errors.mjs";

const PROJECT = "33333333-3333-4333-8333-333333333333";
const API = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ADMIN = { type: "user", userId: "u-admin" };
const MEMBER = { type: "user", userId: "u-member" };

function fakeDb() {
  return {
    stored: { cors: null, version: 3 },
    async getInheritedRole({ userId }) {
      return userId === "u-admin" ? "admin" : "member";
    },
    async listRoleBindings() {
      return { roles: [], grants: [] };
    },
    async getApiCors() {
      return { id: API, project_id: PROJECT, cors: this.stored.cors, version: this.stored.version };
    },
    async updateApiCors({ cors, version }) {
      this.stored = { cors, version };
      return { id: API, project_id: PROJECT, cors, version };
    },
    audits: [],
    async insertAudit(entry) {
      this.audits.push(entry);
    },
  };
}

test("S06: REST Enable CORS creates OPTIONS mock and 200 header mappings", () => {
  const draft = buildEnableCorsDraft({ allowOrigin: "'*'", allowMethods: ["GET", "OPTIONS"] });
  // OPTIONS method with a MOCK integration returning 200 …
  assert.equal(draft.optionsMethod.httpMethod, "OPTIONS");
  assert.equal(draft.optionsMethod.integration.type, "MOCK");
  assert.deepEqual(JSON.parse(draft.optionsMethod.integration.requestTemplates["application/json"]), { statusCode: 200 });
  const integrationResponse = draft.optionsMethod.integration.integrationResponses[0];
  assert.equal(integrationResponse.statusCode, "200");
  assert.equal(integrationResponse.responseParameters["method.response.header.Access-Control-Allow-Origin"], "'*'");
  assert.match(integrationResponse.responseParameters["method.response.header.Access-Control-Allow-Methods"], /GET/);
  assert.match(integrationResponse.responseParameters["method.response.header.Access-Control-Allow-Headers"], /Content-Type/);
  // … and 200 method-response header declarations the user can edit after.
  assert.equal(draft.optionsMethod.methodResponses[0].statusCode, "200");
  assert.equal(draft.optionsMethod.methodResponses[0].responseParameters["method.response.header.Access-Control-Allow-Origin"], false);
  // Selected methods gain the Allow-Origin mapping; gateway-response headers
  // are included only when asked for.
  assert.equal(draft.methodResponseHeaders["method.response.header.Access-Control-Allow-Origin"], true);
  assert.deepEqual(draft.gatewayResponseHeaders, {});
  const withGateway = buildEnableCorsDraft({ includeGatewayResponses: true });
  assert.equal(withGateway.gatewayResponseHeaders["gatewayresponse.header.Access-Control-Allow-Origin"], "'*'");
});

test("S06: CORS control service validates, guards versions and audits", async () => {
  const db = fakeDb();
  const read = await getCors(db, MEMBER, { projectId: PROJECT, apiId: API });
  assert.equal(read.cors, null);
  await assert.rejects(
    putCors(db, MEMBER, { projectId: PROJECT, apiId: API, input: { allowOrigins: ["*"] } }),
    (error) => error instanceof HttpError && error.status === 403,
  );
  await assert.rejects(
    putCors(db, ADMIN, {
      projectId: PROJECT,
      apiId: API,
      input: { allowOrigins: ["*"], allowCredentials: true },
    }),
    (error) => error instanceof HttpError && error.status === 422,
  );
  await assert.rejects(
    putCors(db, ADMIN, { projectId: PROJECT, apiId: API, input: { allowOrigins: ["*"] }, expectedVersion: 99 }),
    (error) => error instanceof HttpError && error.status === 409,
  );
  const saved = await putCors(db, ADMIN, {
    projectId: PROJECT,
    apiId: API,
    input: { allowOrigins: ["https://example.com"], allowMethods: ["GET"], maxAge: 60 },
    expectedVersion: 3,
  });
  assert.deepEqual(saved.cors.allowOrigins, ["https://example.com"]);
  assert.equal(saved.version, 4);
  assert.equal(db.audits.length, 1);
  assert.equal(db.audits[0].action, "cors.update");
});
