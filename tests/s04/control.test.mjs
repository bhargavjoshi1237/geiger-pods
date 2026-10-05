import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { HttpError } from "../../lib/control/errors.mjs";
import {
  createIntegration,
  deleteIntegration,
  getIntegration,
  listIntegrations,
  updateIntegration,
  createIntegrationResponse,
  deleteIntegrationResponse,
  listIntegrationResponses,
} from "../../lib/control/integrations.mjs";
import {
  CONNECTOR_TOKEN_PREFIX,
  createConnector,
  createConnectorToken,
  deleteConnector,
  getConnector,
  listConnectorTokens,
  revokeConnectorToken,
  rotateConnectorToken,
  verifyConnectorToken,
} from "../../lib/control/connectors.mjs";
import {
  deleteClientCertificate,
  generateClientCertificate,
  listClientCertificates,
} from "../../lib/control/client-certificates.mjs";

const PROJECT = "44444444-4444-4444-8444-444444444444";
const REST_API = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const HTTP_API = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ADMIN = { type: "user", userId: "u-admin" };
const MEMBER = { type: "user", userId: "u-member" };

function fakeDb() {
  const store = {
    integrations: new Map(),
    responses: new Map(),
    connectors: new Map(),
    tokens: new Map(),
    certs: new Map(),
    audits: [],
    certRefs: 0,
  };
  const stamp = (row, extra = {}) => ({
    id: randomUUID(),
    created_at: "2026-10-05T00:00:01.000Z",
    updated_at: "2026-10-05T00:00:01.000Z",
    deleted_at: null,
    version: 1,
    ...extra,
    ...row,
  });
  return {
    ...store,
    async getInheritedRole({ userId }) {
      return userId === "u-admin" ? "admin" : userId === "u-member" ? "member" : null;
    },
    async listRoleBindings() {
      return { roles: [], grants: [] };
    },
    async insertAudit(entry) {
      store.audits.push(entry);
    },
    async getApiProtocol({ apiId }) {
      if (apiId === REST_API) return "REST";
      if (apiId === HTTP_API) return "HTTP";
      return null;
    },
    async listIntegrations({ apiId, limit }) {
      return [...store.integrations.values()].filter((row) => row.api_id === apiId && !row.deleted_at).slice(0, limit);
    },
    async getIntegrationById(id) {
      return store.integrations.get(id) ?? null;
    },
    async insertIntegration(row) {
      const saved = stamp(row, { public_id: row.public_id });
      store.integrations.set(saved.id, saved);
      return saved;
    },
    async updateIntegration(id, patch) {
      Object.assign(store.integrations.get(id), patch, { version: store.integrations.get(id).version + 1 });
      return store.integrations.get(id);
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
    async deleteIntegrationResponse(id) {
      store.responses.get(id).deleted_at = "2026-10-05T00:00:02.000Z";
      return { id, deleted: true };
    },
    async listConnectors({ projectId, limit }) {
      return [...store.connectors.values()].filter((row) => row.project_id === projectId && !row.deleted_at).slice(0, limit);
    },
    async getConnectorById(id) {
      return store.connectors.get(id) ?? null;
    },
    async insertConnector(row) {
      for (const existing of store.connectors.values()) {
        if (existing.project_id === row.project_id && existing.name === row.name && !existing.deleted_at) {
          const conflict = new Error("duplicate");
          conflict.code = "23505";
          throw conflict;
        }
      }
      const saved = stamp(row);
      store.connectors.set(saved.id, saved);
      return saved;
    },
    async updateConnector(id, patch) {
      Object.assign(store.connectors.get(id), patch, { version: store.connectors.get(id).version + 1 });
      return store.connectors.get(id);
    },
    async deleteConnector(id) {
      store.connectors.get(id).deleted_at = "2026-10-05T00:00:02.000Z";
      return { id, deleted: true };
    },
    async listConnectorTokens(connectorId) {
      return [...store.tokens.values()].filter((row) => row.connector_id === connectorId);
    },
    async getConnectorTokenById(id) {
      return store.tokens.get(id) ?? null;
    },
    async getConnectorTokenByHash(hash) {
      return [...store.tokens.values()].find((row) => row.token_hash === hash && !row.revoked_at) ?? null;
    },
    async insertConnectorToken(row) {
      const saved = stamp(row);
      store.tokens.set(saved.id, saved);
      return saved;
    },
    async updateConnectorToken(id, patch) {
      Object.assign(store.tokens.get(id), patch);
      return store.tokens.get(id);
    },
    async listClientCertificates({ projectId }) {
      return [...store.certs.values()].filter((row) => row.project_id === projectId && !row.deleted_at);
    },
    async getClientCertificateById(id) {
      return store.certs.get(id) ?? null;
    },
    async insertClientCertificate(row) {
      const saved = stamp(row);
      store.certs.set(saved.id, saved);
      return saved;
    },
    async deleteClientCertificate(id) {
      store.certs.get(id).deleted_at = "2026-10-05T00:00:02.000Z";
      return { id, deleted: true };
    },
    async countClientCertReferences() {
      return Number(this?.certRefs ?? 0);
    },
    async countSecretReferences() {
      return 0;
    },
  };
}

test("S04: integrations CRUD validates type, capability, timeouts and URIs", async () => {
  const db = fakeDb();
  const created = await createIntegration(db, ADMIN, {
    projectId: PROJECT,
    apiId: REST_API,
    input: { type: "HTTP_PROXY", uri: "https://backend.example.com/{proxy}", timeoutMs: 5000 },
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.timeoutMs, 5000);
  assert.match(created.body.publicId, /^[a-z0-9]{10}$/);
  assert.equal(created.body.payloadFormatVersion, "1.0");

  const listed = await listIntegrations(db, ADMIN, { projectId: PROJECT, apiId: REST_API });
  assert.equal(listed.items.length, 1);

  // MOCK is not available on HTTP APIs.
  await assert.rejects(
    createIntegration(db, ADMIN, { projectId: PROJECT, apiId: HTTP_API, input: { type: "MOCK" } }),
    (error) => error instanceof HttpError && error.status === 400 && error.code === "capability_unsupported",
  );
  // HTTP custom is REST/WS-only.
  await assert.rejects(
    createIntegration(db, ADMIN, { projectId: PROJECT, apiId: HTTP_API, input: { type: "HTTP", uri: "https://b.example.com/x" } }),
    (error) => error instanceof HttpError && error.code === "capability_unsupported",
  );
  // REST timeout ceiling is 29000.
  await assert.rejects(
    createIntegration(db, ADMIN, { projectId: PROJECT, apiId: REST_API, input: { type: "MOCK", timeoutMs: 30000 } }),
    (error) => error instanceof HttpError && error.status === 422,
  );
  // Payload 2.0 is HTTP-only.
  await assert.rejects(
    createIntegration(db, ADMIN, { projectId: PROJECT, apiId: REST_API, input: { type: "MOCK", payloadFormatVersion: "2.0" } }),
    (error) => error instanceof HttpError && error.status === 422,
  );
  // HTTP integrations require a uri; CONNECTOR requires a connectorId.
  await assert.rejects(
    createIntegration(db, ADMIN, { projectId: PROJECT, apiId: REST_API, input: { type: "HTTP_PROXY" } }),
    (error) => error instanceof HttpError && error.status === 422,
  );
  await assert.rejects(
    createIntegration(db, ADMIN, { projectId: PROJECT, apiId: REST_API, input: { type: "HTTP_PROXY", uri: "https://b.example.com/x", connectionType: "CONNECTOR" } }),
    (error) => error instanceof HttpError && error.status === 422,
  );
  // Non-http schemes are rejected.
  await assert.rejects(
    createIntegration(db, ADMIN, { projectId: PROJECT, apiId: REST_API, input: { type: "HTTP_PROXY", uri: "ftp://b.example.com/x" } }),
    (error) => error instanceof HttpError && error.status === 422,
  );
  // Bad secret refs are rejected.
  await assert.rejects(
    createIntegration(db, ADMIN, {
      projectId: PROJECT, apiId: REST_API,
      input: { type: "HTTP_PROXY", uri: "https://b.example.com/x", backendAuth: { type: "bearer", secretRef: "nope" } },
    }),
    (error) => error instanceof HttpError && error.status === 422,
  );

  // Optimistic concurrency + cross-project isolation.
  const fetched = await getIntegration(db, ADMIN, { projectId: PROJECT, apiId: REST_API, integrationId: created.body.id });
  assert.equal(fetched.uri, "https://backend.example.com/{proxy}");
  await assert.rejects(
    updateIntegration(db, ADMIN, {
      projectId: PROJECT, apiId: REST_API, integrationId: created.body.id,
      patch: { timeoutMs: 1000 }, expectedVersion: 999,
    }),
    (error) => error instanceof HttpError && error.status === 409,
  );
  const updated = await updateIntegration(db, ADMIN, {
    projectId: PROJECT, apiId: REST_API, integrationId: created.body.id,
    patch: { timeoutMs: 1000 }, expectedVersion: 1,
  });
  assert.equal(updated.timeoutMs, 1000);
  await assert.rejects(
    getIntegration(db, ADMIN, { projectId: "other", apiId: REST_API, integrationId: created.body.id }),
    (error) => error instanceof HttpError && error.status === 404,
  );
  const removed = await deleteIntegration(db, ADMIN, { projectId: PROJECT, apiId: REST_API, integrationId: created.body.id });
  assert.equal(removed.deleted, true);

  // Free-form aws.parameters survive validation; backendAuth clears on null.
  const awsCreated = await createIntegration(db, ADMIN, {
    projectId: PROJECT,
    apiId: REST_API,
    input: {
      type: "AWS_SERVICE",
      aws: { subtype: "SQS-SendMessage", region: "us-east-1", parameters: { QueueUrl: "q", MessageBody: "hi" } },
    },
  });
  assert.deepEqual(awsCreated.body.aws.parameters, { QueueUrl: "q", MessageBody: "hi" });
  const authed = await updateIntegration(db, ADMIN, {
    projectId: PROJECT, apiId: REST_API, integrationId: awsCreated.body.id,
    patch: { backendAuth: { type: "bearer", secretRef: "secret:abc" } }, expectedVersion: 1,
  });
  assert.equal(authed.backendAuth.type, "bearer");
  const cleared = await updateIntegration(db, ADMIN, {
    projectId: PROJECT, apiId: REST_API, integrationId: awsCreated.body.id,
    patch: { backendAuth: null }, expectedVersion: 2,
  });
  assert.equal(cleared.backendAuth, null);

  // Members cannot write integrations.
  await assert.rejects(
    createIntegration(db, MEMBER, { projectId: PROJECT, apiId: REST_API, input: { type: "MOCK" } }),
    (error) => error instanceof HttpError && error.status === 403,
  );
});

test("S04: integration responses validate selection regexes", async () => {
  const db = fakeDb();
  const created = await createIntegration(db, ADMIN, {
    projectId: PROJECT, apiId: REST_API, input: { type: "FUNCTION" },
  });
  await assert.rejects(
    createIntegrationResponse(db, ADMIN, {
      projectId: PROJECT, apiId: REST_API, integrationId: created.body.id,
      input: { statusCode: 404, selectionPattern: "([invalid" },
    }),
    (error) => error instanceof HttpError && error.status === 422,
  );
  const ok = await createIntegrationResponse(db, ADMIN, {
    projectId: PROJECT, apiId: REST_API, integrationId: created.body.id,
    input: { statusCode: 404, selectionPattern: "bo+m" },
  });
  assert.equal(ok.status, 201);
  const listed = await listIntegrationResponses(db, ADMIN, { projectId: PROJECT, apiId: REST_API, integrationId: created.body.id });
  assert.equal(listed.items.length, 1);
  const removed = await deleteIntegrationResponse(db, ADMIN, {
    projectId: PROJECT, apiId: REST_API, integrationId: created.body.id, responseId: ok.body.id,
  });
  assert.equal(removed.deleted, true);
});

test("S04: connectors manage tokens with show-once lifecycle and a 5-token cap", async () => {
  const db = fakeDb();
  const created = await createConnector(db, ADMIN, {
    projectId: PROJECT, input: { name: "vpc-a", allowedTargets: ["10.0.0.0/8:8080"] },
  });
  assert.equal(created.body.status, "PENDING");
  const fetched = await getConnector(db, ADMIN, { projectId: PROJECT, connectorId: created.body.id });
  assert.deepEqual(fetched.allowedTargets, ["10.0.0.0/8:8080"]);

  await assert.rejects(
    createConnector(db, ADMIN, { projectId: PROJECT, input: { name: "bad", allowedTargets: ["nota-target"] } }),
    (error) => error instanceof HttpError && error.status === 422,
  );

  const first = await createConnectorToken(db, ADMIN, { projectId: PROJECT, connectorId: created.body.id });
  assert.ok(first.body.token.startsWith(CONNECTOR_TOKEN_PREFIX));
  assert.equal(first.body.token.length, CONNECTOR_TOKEN_PREFIX.length + 32);
  // The stored row never carries the plaintext.
  assert.ok(!("token" in (await db.getConnectorTokenById(first.body.id))));
  assert.ok(!("token_hash" in first.body));

  const verified = await verifyConnectorToken(db, first.body.token);
  assert.equal(verified.connector_id, created.body.id);
  assert.equal(await verifyConnectorToken(db, "bogus"), null);
  assert.equal(await verifyConnectorToken(db, `${CONNECTOR_TOKEN_PREFIX}wrong`), null);

  for (let index = 0; index < 4; index += 1) {
    await createConnectorToken(db, ADMIN, { projectId: PROJECT, connectorId: created.body.id });
  }
  await assert.rejects(
    createConnectorToken(db, ADMIN, { projectId: PROJECT, connectorId: created.body.id }),
    (error) => error instanceof HttpError && error.status === 409,
  );
  const tokens = await listConnectorTokens(db, ADMIN, { projectId: PROJECT, connectorId: created.body.id });
  assert.equal(tokens.items.length, 5);
  assert.ok(tokens.items.every((token) => !("token_hash" in token)));

  const revoked = await revokeConnectorToken(db, ADMIN, { projectId: PROJECT, connectorId: created.body.id, tokenId: first.body.id });
  assert.equal(revoked.revoked, true);
  assert.equal(await verifyConnectorToken(db, first.body.token), null);

  const rotated = await rotateConnectorToken(db, ADMIN, {
    projectId: PROJECT, connectorId: created.body.id, tokenId: tokens.items[1].id,
  });
  assert.ok(rotated.body.created.token.startsWith(CONNECTOR_TOKEN_PREFIX));

  const removed = await deleteConnector(db, ADMIN, { projectId: PROJECT, connectorId: created.body.id });
  assert.equal(removed.deleted, true);

  await assert.rejects(
    createConnector(db, MEMBER, { projectId: PROJECT, input: { name: "nope" } }),
    (error) => error instanceof HttpError && error.status === 403,
  );
});

test("S04: client certificates generate with the public PEM only; delete is refused while referenced", async () => {
  const db = fakeDb();
  const fakeIssue = () => ({
    certificatePem: "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n",
    privateKeyPem: "-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----\n",
    notAfter: new Date("2027-10-05T00:00:00.000Z"),
  });
  let sealed = null;
  const created = await generateClientCertificate(db, ADMIN, {
    projectId: PROJECT, input: { description: "backend mtls" },
  }, {
    issueCertificate: fakeIssue,
    createSecretFn: async (vaultDb, actor, input) => {
      sealed = input;
      return { id: "secret-uuid-1" };
    },
  });
  assert.equal(created.status, 201);
  assert.match(created.body.certificatePem, /BEGIN CERTIFICATE/);
  assert.ok(!JSON.stringify(created.body).includes("MIIE"), "private key leaked into the response");
  assert.equal(sealed.kind, "client_certificate");
  assert.equal(sealed.value.privateKeyPem, "-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----\n");
  assert.equal(created.body.publicId.length, 10);

  const listed = await listClientCertificates(db, ADMIN, { projectId: PROJECT });
  assert.equal(listed.items.length, 1);

  db.certRefs = 1;
  await assert.rejects(
    deleteClientCertificate(db, ADMIN, { projectId: PROJECT, certificateId: created.body.id }),
    (error) => error instanceof HttpError && error.status === 409,
  );
  db.certRefs = 0;
  const removed = await deleteClientCertificate(db, ADMIN, { projectId: PROJECT, certificateId: created.body.id });
  assert.equal(removed.deleted, true);
});

test("S04: [db] RLS isolates integrations, connector tokens and client certs", async (t) => {
  if (!process.env.PODS_TEST_DB_URL) {
    t.skip("No PODS_TEST_DB_URL; live-database RLS proof needs a disposable Postgres.");
    return;
  }
  assert.fail("DB harness not wired: set PODS_TEST_DB_URL and implement with two users and two projects.");
});
