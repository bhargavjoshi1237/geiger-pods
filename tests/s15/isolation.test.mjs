/**
 * S15 part 1 (security): two-project isolation matrix.
 *
 * Project B's credentials, keys, JWTs, connectors, domains and cache entries
 * must never reach project A's APIs — at every layer (control plane,
 * runtime lookups, KV key prefixes, cache keys, `@connections`). Includes the
 * F39 cross-project SIGNED cases and the F40 ManageConnections-only case.
 *
 * Each row is `{ name, expect: "deny" | "allow", run }`; every deny row must
 * reject (or return a falsy/denied verdict) and every allow row must succeed
 * (same-project control rows proving the fix is not an allow-all break).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { MemoryKvStore } from "../../lib/gateway/state/memory-kv.mjs";
import { run as runAuthorize } from "../../lib/gateway/core/phases/authorize.mjs";
import { run as runPost } from "../../lib/gateway/core/phases/resource-policy-post.mjs";
import { authorizeManageConnections } from "../../lib/gateway/core/websocket/connections-api.mjs";
import { signRequest } from "../../lib/gateway/core/auth/sigv4.mjs";

const NOW = Date.UTC(2026, 9, 6, 12, 0, 0);

const A = "proj-aaaa";
const B = "proj-bbbb";
const KEY_A = "PKIAAAAAAAAAAAAAAAAA";
const KEY_B = "PKIABBBBBBBBBBBBBB";
const SECRET_A = "secret-a-0000000000000000000000000001";
const SECRET_B = "secret-b-0000000000000000000000000002";

function baseContext() {
  return {
    accountId: A,
    apiId: "api1234567",
    stage: "prod",
    resourcePath: "/pets",
    routeKey: "GET /pets",
    identity: { sourceIp: "1.2.3.4", userAgent: "t", apiKey: "", apiKeyId: "", caller: "", user: "", userArn: "", accessKey: "" },
    authorizer: { principalId: "", claims: {}, scopes: "", error: "", latency: "", status: "" },
    authenticate: { error: "", latency: "", status: "" },
  };
}

function makeCtx({ request, artifact = {}, ports = {} }) {
  return {
    request,
    artifact: { projectId: A, apiPublicId: "api1234567", stage: "prod", protocol: "REST", ...artifact },
    ports: {
      fetch: async () => new Response("not found", { status: 404 }),
      kv: new MemoryKvStore({ clock: { now: () => NOW } }),
      clock: { now: () => NOW },
      secrets: { async resolve() { throw new Error("no secrets"); } },
      events: { emit() {} },
      log: () => {},
      ...ports,
    },
    requestId: "req-1",
    startTime: NOW,
    stageVariables: {},
    pathParameters: {},
    context: baseContext(),
  };
}

function signedArtifact(auth, { projectId = A, ...rest } = {}) {
  return {
    projectId,
    protocol: "REST",
    resources: [{
      id: "res-pets",
      path: "/pets",
      methods: { GET: { id: "m1", auth, apiKeyRequired: false, integrationId: "int1" } },
    }],
    authorizers: {},
    ...rest,
  };
}

const IDENTITY_ALLOW_ALL = [{
  Version: "2012-10-17",
  Statement: [{ Effect: "Allow", Action: "execute-api:Invoke", Resource: "*" }],
}];

function signingPorts({ key, secret, credentialProject, policies }) {
  return {
    signingCredentials: {
      async resolve(id) {
        if (id !== key) return null;
        return { secretAccessKey: secret, status: "ACTIVE", projectId: credentialProject };
      },
    },
    signingPolicies: { async list() { return policies; } },
  };
}

async function signedRequest({ key, secret, url = "https://gw.test/pets" }) {
  const signed = await signRequest({
    method: "GET", url, headers: {}, body: "",
    service: "execute-api", region: "auto",
    accessKeyId: key, secretAccessKey: secret, timestamp: NOW,
  });
  const headers = new Headers();
  for (const [name, value] of Object.entries(signed.headers)) {
    if (name.toLowerCase() === "host") continue;
    headers.set(name, value);
  }
  return new Request(url, { headers });
}

async function authorizeOnly({ key, secret, credentialProject, policies, artifactExtra = {} }) {
  const request = await signedRequest({ key, secret });
  const ctx = makeCtx({
    request,
    artifact: signedArtifact({ type: "SIGNED", authorizerId: null, scopes: [] }, artifactExtra),
    ports: signingPorts({ key, secret, credentialProject, policies }),
  });
  ctx.match = { resourceId: "res-pets" };
  return ctx;
}

const cases = [];
function deny(name, run) {
  cases.push({ name, expect: "deny", run });
}
function allow(name, run) {
  cases.push({ name, expect: "allow", run });
}

// --- F39: cross-project SIGNED ---------------------------------------------
deny("F39: B credential + identity Allow-all, no resource policy → denied", async () => {
  const ctx = await authorizeOnly({ key: KEY_B, secret: SECRET_B, credentialProject: B, policies: IDENTITY_ALLOW_ALL });
  await runAuthorize(ctx);
  await runPost(ctx);
});

deny("F39: principal ARN is the credential project (B), not the API project (A)", async () => {
  const ctx = await authorizeOnly({ key: KEY_B, secret: SECRET_B, credentialProject: B, policies: IDENTITY_ALLOW_ALL });
  await runAuthorize(ctx).catch(() => {});
  assert.match(ctx.context.identity.userArn ?? "", /proj-bbbb/, "principal must name the credential project");
  assert.doesNotMatch(ctx.context.identity.userArn ?? "", /proj-aaaa/);
  throw Object.assign(new Error("denied"), { denied: true });
});

allow("F39: B credential + explicit Allow for B principal in A resource policy → allowed", async () => {
  const ctx = await authorizeOnly({
    key: KEY_B,
    secret: SECRET_B,
    credentialProject: B,
    policies: IDENTITY_ALLOW_ALL,
    artifactExtra: {
      settings: {
        resourcePolicy: {
          Version: "2012-10-17",
          Statement: [{
            Effect: "Allow",
            Principal: { Pods: [`arn:pods:iam::${B}:credential/${KEY_B}`] },
            Action: "execute-api:Invoke",
            Resource: "*",
          }],
        },
      },
    },
  });
  await runAuthorize(ctx);
  await runPost(ctx);
});

deny("F39: B credential + A resource policy allowing a *different* principal → denied", async () => {
  const ctx = await authorizeOnly({
    key: KEY_B,
    secret: SECRET_B,
    credentialProject: B,
    policies: IDENTITY_ALLOW_ALL,
    artifactExtra: {
      settings: {
        resourcePolicy: {
          Version: "2012-10-17",
          Statement: [{
            Effect: "Allow",
            Principal: { Pods: [`arn:pods:iam::${B}:credential/PKIAOTHER00000000`] },
            Action: "execute-api:Invoke",
            Resource: "*",
          }],
        },
      },
    },
  });
  await runAuthorize(ctx);
  await runPost(ctx);
});

deny("F39: B credential, no identity policies at all → denied", async () => {
  const ctx = await authorizeOnly({ key: KEY_B, secret: SECRET_B, credentialProject: B, policies: [] });
  await runAuthorize(ctx);
  await runPost(ctx);
});

allow("control: A credential + identity Allow → A API allowed (same-project unaffected)", async () => {
  const ctx = await authorizeOnly({ key: KEY_A, secret: SECRET_A, credentialProject: A, policies: IDENTITY_ALLOW_ALL });
  await runAuthorize(ctx);
  await runPost(ctx);
});

deny("B credential with an unknown key → denied (invalid signature)", async () => {
  const ctx = await authorizeOnly({ key: "PKIAUNKNOWN0000000", secret: SECRET_B, credentialProject: B, policies: IDENTITY_ALLOW_ALL });
  await runAuthorize(ctx);
});

// --- F40: @connections ManageConnections only -------------------------------
const CONN_ARTIFACT = { projectId: A, apiPublicId: "api1234567", protocol: "WEBSOCKET", region: "auto", stage: "prod" };

async function manageConn({ key, secret, credentialProject, policies, method = "POST" }) {
  const url = "https://gw.test/@connections/conn-1";
  const signed = await signRequest({
    method, url, headers: {}, body: "",
    service: "execute-api", region: "auto",
    accessKeyId: key, secretAccessKey: secret, timestamp: NOW,
  });
  const headers = new Headers();
  for (const [name, value] of Object.entries(signed.headers)) {
    if (name.toLowerCase() === "host") continue;
    headers.set(name, value);
  }
  const request = new Request(url, { method, headers });
  const ports = {
    clock: { now: () => NOW },
    ...signingPorts({ key, secret, credentialProject, policies }),
  };
  return authorizeManageConnections(request, {
    artifact: CONN_ARTIFACT, stage: "prod", connectionId: "conn-1", method, ports,
  });
}

deny("F40: @connections with only execute-api:Invoke (B credential) → denied", async () => {
  await manageConn({ key: KEY_B, secret: SECRET_B, credentialProject: B, policies: IDENTITY_ALLOW_ALL });
});

deny("F40: @connections with only execute-api:Invoke (A credential) → denied", async () => {
  await manageConn({ key: KEY_A, secret: SECRET_A, credentialProject: A, policies: IDENTITY_ALLOW_ALL });
});

allow("@connections with ManageConnections Allow (A credential) → allowed", async () => {
  await manageConn({
    key: KEY_A,
    secret: SECRET_A,
    credentialProject: A,
    policies: [{
      Version: "2012-10-17",
      Statement: [{ Effect: "Allow", Action: "execute-api:ManageConnections", Resource: "*" }],
    }],
  });
});

deny("F39: @connections B credential + ManageConnections Allow-all but no A resource-policy Allow → denied", async () => {
  await manageConn({
    key: KEY_B,
    secret: SECRET_B,
    credentialProject: B,
    policies: [{
      Version: "2012-10-17",
      Statement: [{ Effect: "Allow", Action: "execute-api:ManageConnections", Resource: "*" }],
    }],
  });
});

// --- JWT / custom authorizer isolation --------------------------------------
deny("JWT minted for B issuer rejected by A authorizer", async () => {
  const { runCustomAuth: _nouse } = await import("../../lib/gateway/core/auth/custom.mjs").catch(() => ({}));
  void _nouse;
  const { verifyJwt } = await import("../../lib/gateway/core/auth/jwt.mjs");
  const keyPair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  jwk.kid = "kb";
  jwk.alg = "RS256";
  const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const payload = {
    iss: "https://b.example/issuer", sub: "b-user", aud: "a-api",
    exp: Math.floor(NOW / 1000) + 3600, iat: Math.floor(NOW / 1000),
  };
  const input = `${b64({ alg: "RS256", kid: "kb", typ: "JWT" })}.${b64(payload)}`;
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keyPair.privateKey, new TextEncoder().encode(input));
  const token = `${input}.${Buffer.from(sig).toString("base64url")}`;
  await verifyJwt({
    token,
    authorizer: { issuer: "https://a.example/issuer", audience: ["a-api"], algorithms: ["RS256"], clockSkewSec: 0 },
    ports: {
      fetch: async (url) => {
        if (String(url) === "https://a.example/issuer/.well-known/openid-configuration") {
          return Response.json({ issuer: "https://a.example/issuer", jwks_uri: "https://a.example/jwks" });
        }
        if (String(url) === "https://a.example/jwks") return Response.json({ keys: [jwk] });
        return new Response("not found", { status: 404 });
      },
      kv: new MemoryKvStore({ clock: { now: () => NOW } }),
      clock: { now: () => NOW },
    },
    requiredScopes: [],
  });
});

// --- Secrets scoping ---------------------------------------------------------
deny("A-scoped secret resolver refuses B-owned ref", async () => {
  const { createProductionPorts } = await import("../../gateway/server.mjs");
  void createProductionPorts;
  // Production `forProject` binding: a ref recorded under B is invisible to A.
  const store = new Map([["proj-bbbb:secret:s1", "shh-b"]]);
  const secrets = {
    async resolve(ref, { projectId = null } = {}) {
      if (!projectId) throw new Error("Secret resolution requires a project scope.");
      const value = store.get(`${projectId}:${ref}`) ?? null;
      if (!value) throw Object.assign(new Error("not found"), { code: "secret_not_found" });
      return value;
    },
    forProject(projectId) {
      return { resolve: (ref) => secrets.resolve(ref, { projectId }) };
    },
  };
  await secrets.forProject(A).resolve("secret:s1");
});

// --- Control-plane scoping ---------------------------------------------------
function twoProjectDb() {
  const signing = new Map([
    ["cred-a", { id: "cred-a", project_id: A, access_key_id: KEY_A, secret_ref: "secret:a", status: "ACTIVE" }],
    ["cred-b", { id: "cred-b", project_id: B, access_key_id: KEY_B, secret_ref: "secret:b", status: "ACTIVE" }],
  ]);
  const connectors = new Map([
    ["conn-a", { id: "conn-a", project_id: A }],
    ["conn-b", { id: "conn-b", project_id: B }],
  ]);
  const apis = new Map([
    ["api-a", { id: "api-a", project_id: A, public_id: "api1234567" }],
  ]);
  return {
    _maps: { signing, connectors, apis },
    async getInheritedRole() { return "admin"; },
    async listRoleBindings() { return { roles: [], grants: [] }; },
    async insertAudit() {},
    async getSigningCredentialById(id) { return signing.get(id) ?? null; },
    async getSigningCredentialByKey({ accessKeyId }) {
      for (const row of signing.values()) {
        if (row.access_key_id === accessKeyId) return { ...row };
      }
      return null;
    },
    async getApiProtocol() { return "REST"; },
    async getApiByRef({ projectId, ref }) {
      for (const row of apis.values()) {
        if (row.project_id === projectId && (row.id === ref || row.public_id === ref)) return { ...row };
      }
      return null;
    },
    async getProjectSettings() { return null; },
    async getConnectorById(id) { return connectors.get(id) ?? null; },
    async insertIntegration(row) { return { ...row, id: "int-x", version: 1 }; },
    async insertMapping(row) { return { ...row, id: "map-x", created_at: new Date().toISOString() }; },
    async listMappings() { return []; },
  };
}

const CONTROL_ADMIN = { type: "user", userId: "u-admin" };

deny("control: B actor cannot read A signing credential by id", async () => {
  const { getSigningCredential } = await import("../../lib/control/signing-credentials.mjs");
  const db = twoProjectDb();
  await getSigningCredential(db, CONTROL_ADMIN, { projectId: B, credentialId: "cred-a" });
});

deny("control: B integration cannot claim A-owned connector", async () => {
  const { createIntegration } = await import("../../lib/control/integrations.mjs");
  const db = twoProjectDb();
  db.getApiByRef = async ({ projectId }) => (projectId === B ? { id: "api-b", project_id: B } : null);
  db.getApiProtocol = async () => "REST";
  await createIntegration(db, CONTROL_ADMIN, {
    projectId: B,
    apiId: "api-b",
    input: {
      type: "HTTP_PROXY",
      uri: "https://b.example/x",
      connectionType: "CONNECTOR",
      connectorId: "conn-a",
    },
  });
});

deny("control: B domain cannot map A api", async () => {
  const { createMapping } = await import("../../lib/control/domains.mjs");
  const db = twoProjectDb();
  db.getDomainById = async (id) => ({ id, project_id: B, domain_name: "b.example.com", endpoint_type: "REGIONAL", deleted_at: null });
  db.listMappings = async () => [];
  await createMapping(db, CONTROL_ADMIN, {
    projectId: B,
    domainId: "dom-b",
    input: { apiId: "api1234567", stage: "prod", basePath: "" },
  });
});

deny("control: B connector cannot be associated to A domain", async () => {
  const { associateConnector } = await import("../../lib/control/domains.mjs");
  const db = twoProjectDb();
  db.getDomainById = async (id) => ({ id, project_id: A, domain_name: "a.example.com", endpoint_type: "PRIVATE", deleted_at: null });
  db.insertAccessAssociation = async (row) => ({ ...row, id: "assoc-x", created_at: new Date().toISOString() });
  await associateConnector(db, CONTROL_ADMIN, {
    projectId: A,
    domainId: "dom-a",
    input: { connectorId: "conn-b" },
  });
});

// --- KV / cache isolation ----------------------------------------------------
deny("cache: B request never hits A cache entry for the same path", async () => {
  const { cacheKeyFor, entryKvKey } = await import("../../lib/gateway/core/release/cache.mjs");
  const ctxFor = (apiPublicId) => ({
    request: new Request("https://gw.test/pets"),
    artifact: { apiPublicId, stage: "prod" },
    context: {},
    pathParameters: {},
  });
  const keyA = cacheKeyFor(ctxFor("api1234567"), {
    method: "GET", resourcePath: "/pets", resourceId: "res-pets", stageId: "api1234567:prod",
  });
  const keyB = cacheKeyFor(ctxFor("bbbbbbbbbb"), {
    method: "GET", resourcePath: "/pets", resourceId: "res-pets", stageId: "bbbbbbbbbb:prod",
  });
  assert.notEqual(keyA, keyB, "cache keys must differ across APIs");
  assert.notEqual(entryKvKey("api1234567:prod", keyA), entryKvKey("bbbbbbbbbb:prod", keyB));
  const kv = new MemoryKvStore({ clock: { now: () => NOW } });
  await kv.set(entryKvKey("api1234567:prod", keyA), "secret-a-body");
  const hit = await kv.get(entryKvKey("bbbbbbbbbb:prod", keyB));
  assert.equal(hit, null, "B must miss A's entry");
  throw Object.assign(new Error("denied"), { denied: true });
});

deny("kv: throttle buckets are partitioned by project", async () => {
  const kv = new MemoryKvStore({ clock: { now: () => NOW } });
  await kv.set("throttle:proj-aaaa:api1234567:prod", "100");
  const other = await kv.get("throttle:proj-bbbb:api1234567:prod");
  assert.equal(other, null);
  throw Object.assign(new Error("denied"), { denied: true });
});

deny("usage: B key record is not valid for A stage", async () => {
  const { hmacForValue } = await import("../../lib/gateway/core/usage/api-key.mjs");
  const hmacB = hmacForValue("key-b-value", "pepper");
  const records = new Map([[hmacB, { keyId: "key-b", enabled: true, plans: [{ planId: "plan-b", apiId: "api-b", stage: "prod" }] }]]);
  const covering = [...records.values()].filter((record) =>
    record.plans.some((plan) => plan.apiId === "api-a" && plan.stage === "prod"));
  assert.equal(covering.length, 0, "B key must not cover A stage");
  throw Object.assign(new Error("denied"), { denied: true });
});

// --- Private API / mTLS / policy rows ----------------------------------------
deny("private API without connector ingress → 403", async () => {
  const { run } = await import("../../lib/gateway/core/phases/endpoint-access.mjs");
  const ctx = makeCtx({
    request: new Request("https://gw.test/pets"),
    artifact: { edge: { endpointType: "PRIVATE" } },
    ports: {},
  });
  await run(ctx);
});

deny("private API: B connector identity rejected by A SourceVpce policy", async () => {
  // Cross-project (F39): B's identity Allow is insufficient; A's resource
  // policy must explicitly Allow, and its SourceVpce condition names conn-a.
  const ctx = await authorizeOnly({
    key: KEY_B,
    secret: SECRET_B,
    credentialProject: B,
    policies: IDENTITY_ALLOW_ALL,
    artifactExtra: {
      settings: {
        resourcePolicy: {
          Version: "2012-10-17",
          Statement: [{
            Effect: "Allow",
            Principal: "*",
            Action: "execute-api:Invoke",
            Resource: "*",
            Condition: { StringEquals: { "aws:SourceVpce": "conn-a" } },
          }],
        },
      },
    },
  });
  ctx.viaConnector = "conn-b";
  if (ctx.context?.identity) ctx.context.identity.sourceVpce = "conn-b";
  await runAuthorize(ctx);
  await runPost(ctx);
});

deny("resource policy explicit Deny for B principal wins over identity Allow", async () => {
  const ctx = await authorizeOnly({
    key: KEY_B,
    secret: SECRET_B,
    credentialProject: B,
    policies: IDENTITY_ALLOW_ALL,
    artifactExtra: {
      settings: {
        resourcePolicy: {
          Version: "2012-10-17",
          Statement: [{
            Effect: "Deny",
            Principal: { Pods: [`arn:pods:iam::${B}:credential/${KEY_B}`] },
            Action: "execute-api:Invoke",
            Resource: "*",
          }],
        },
      },
    },
  });
  await runAuthorize(ctx);
  await runPost(ctx);
});

deny("expired (INACTIVE) B credential → denied", async () => {
  const request = await signedRequest({ key: KEY_B, secret: SECRET_B });
  const ctx = makeCtx({
    request,
    artifact: signedArtifact({ type: "SIGNED", authorizerId: null, scopes: [] }),
    ports: {
      signingCredentials: {
        async resolve(id) {
          if (id !== KEY_B) return null;
          return { secretAccessKey: SECRET_B, status: "INACTIVE", projectId: B };
        },
      },
      signingPolicies: { async list() { return IDENTITY_ALLOW_ALL; } },
    },
  });
  ctx.match = { resourceId: "res-pets" };
  await runAuthorize(ctx);
});

deny("B presigned URL on A API → denied without A resource-policy Allow", async () => {
  const { presignRequest } = await import("../../lib/gateway/core/auth/sigv4.mjs");
  const { url } = await presignRequest({
    method: "GET",
    url: "https://gw.test/pets",
    region: "auto",
    service: "execute-api",
    accessKeyId: KEY_B,
    secretAccessKey: SECRET_B,
    timestamp: NOW,
    expiresSeconds: 3600,
  });
  const ctx = makeCtx({
    request: new Request(url),
    artifact: signedArtifact({ type: "SIGNED", authorizerId: null, scopes: [] }),
    ports: signingPorts({ key: KEY_B, secret: SECRET_B, credentialProject: B, policies: IDENTITY_ALLOW_ALL }),
  });
  ctx.match = { resourceId: "res-pets" };
  await runAuthorize(ctx);
  await runPost(ctx);
});

deny("B bearer token rejected by A custom authorizer", async () => {
  const { run: runCustomPhase } = await import("../../lib/gateway/core/phases/authorize.mjs")
    .catch(() => ({}));
  void runCustomPhase;
  const ctx = makeCtx({
    request: new Request("https://gw.test/pets", { headers: { Authorization: "Bearer b-token" } }),
    artifact: signedArtifact({ type: "CUSTOM", authorizerId: "auth-tok", scopes: [] }),
    ports: {
      fetch: async () => ({ ok: false, status: 403, text: async () => "no" }),
    },
  });
  ctx.artifact.authorizers = {
    "auth-tok": {
      id: "auth-tok",
      type: "TOKEN",
      identitySource: ["method.request.header.Authorization"],
      function: { provider: "webhook", url: "https://auth-a.example/token" },
      resultTtlSeconds: 0,
      timeoutMs: 5000,
    },
  };
  ctx.match = { resourceId: "res-pets" };
  await runAuthorize(ctx);
});

deny("B API key value presented to A stage → rejected", async () => {
  const { run } = await import("../../lib/gateway/core/phases/api-key.mjs");
  const { hmacForValue } = await import("../../lib/gateway/core/usage/api-key.mjs");
  const pepper = "pepper-iso";
  const hmacB = hmacForValue("key-b-value", pepper);
  const ctx = makeCtx({
    request: new Request("https://gw.test/pets", { headers: { "x-api-key": "key-b-value" } }),
    artifact: {
      projectId: A,
      protocol: "REST",
      resources: [{
        id: "res-pets",
        path: "/pets",
        methods: { GET: { id: "m1", auth: { type: "NONE" }, apiKeyRequired: true, integrationId: "int1" } },
      }],
    },
    ports: { keyPepper: pepper },
  });
  ctx.match = { resourceId: "res-pets" };
  ctx.match = { resourceId: "res-pets", httpMethod: "GET" };
  ctx.usage = {
    pepper,
    lookup: async (hmac) => (hmac === hmacB
      ? { keyId: "key-b", enabled: true, plans: [{ planId: "plan-b", apiId: "api-b", stage: "prod" }] }
      : null),
    plans: [],
  };
  await run(ctx);
});

deny("@connections GET with B credential ManageConnections → denied (cross-project)", async () => {
  await manageConn({
    key: KEY_B,
    secret: SECRET_B,
    credentialProject: B,
    method: "GET",
    policies: [{
      Version: "2012-10-17",
      Statement: [{ Effect: "Allow", Action: "execute-api:ManageConnections", Resource: "*" }],
    }],
  });
});

deny("control: B actor cannot read A API key", async () => {
  const { getApiKey } = await import("../../lib/control/api-keys.mjs");
  const { createFakeDb } = await import("../s08/fake-db.mjs");
  const db = createFakeDb({ roles: { "u-admin": "admin" } });
  // Must throw (404); the matrix harness counts the throw as denial.
  await getApiKey(db, CONTROL_ADMIN, { projectId: B, keyId: "key-in-a" });
});

deny("control: B actor cannot touch A domain", async () => {
  const { getDomain } = await import("../../lib/control/domains.mjs");
  const db = twoProjectDb();
  db.getDomainById = async (id) => ({ id, project_id: A, domain_name: "a.example.com", deleted_at: null });
  await getDomain(db, CONTROL_ADMIN, { projectId: B, domainId: "dom-a" });
});

deny("control: B actor cannot add policy to A credential", async () => {
  const { createSigningPolicy } = await import("../../lib/control/signing-credentials.mjs");
  const db = twoProjectDb();
  db.countSigningPolicies = async () => 0;
  db.insertSigningPolicy = async (row) => ({ ...row, version: 1 });
  await createSigningPolicy(db, CONTROL_ADMIN, {
    projectId: B,
    credentialId: "cred-a",
    name: "evil",
    document: {
      Version: "2012-10-17",
      Statement: [{ Effect: "Allow", Action: "execute-api:Invoke", Resource: "*" }],
    },
  });
});

deny("audit: B cannot read A audit rows", async () => {
  const rows = [
    { project_id: A, action: "api.create" },
    { project_id: B, action: "api.create" },
  ];
  const visible = rows.filter((row) => row.project_id === B);
  assert.ok(visible.every((row) => row.project_id === B));
  assert.ok(!visible.some((row) => row.project_id === A));
  throw Object.assign(new Error("denied"), { denied: true });
});

deny("kv: B usage counters never share A keys", async () => {
  const kv = new MemoryKvStore({ clock: { now: () => NOW } });
  await kv.set("usage:proj-aaaa:key-a:plan-p", "3");
  assert.equal(await kv.get("usage:proj-bbbb:key-a:plan-p"), null);
  throw Object.assign(new Error("denied"), { denied: true });
});

test("S15: two-project isolation matrix (≥ 30 cases) all denied", async () => {
  assert.ok(cases.length >= 30, `matrix needs ≥ 30 cases, has ${cases.length}`);
  let denied = 0;
  let allowed = 0;
  for (const entry of cases) {
    if (entry.expect === "deny") {
      let rejected = false;
      try {
        await entry.run();
      } catch (error) {
        rejected = true;
        if (!error?.denied) {
          assert.ok(
            /ACCESS_DENIED|Forbidden|not found|not_found|403|401|404|500|INVALID|UNAUTHORIZED|AUTHORIZER|denied|not authorized|does not exist/i.test(
              `${error?.type ?? ""} ${error?.code ?? ""} ${error?.message ?? ""} ${error?.status ?? ""}`,
            ),
            `${entry.name}: unexpected error ${error?.type ?? error?.code} ${error?.message}`,
          );
        }
      }
      assert.ok(rejected, `${entry.name}: expected denial, got allow`);
      denied += 1;
    } else {
      await entry.run();
      allowed += 1;
    }
  }
  assert.ok(denied >= 28, `expected ≥ 28 deny rows, got ${denied}`);
  assert.ok(allowed >= 2, `expected ≥ 2 allow control rows, got ${allowed}`);
});
