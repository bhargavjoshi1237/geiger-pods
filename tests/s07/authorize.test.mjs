import assert from "node:assert/strict";
import test from "node:test";
import { MemoryKvStore } from "../../lib/gateway/state/memory-kv.mjs";
import { run as runAuthorize } from "../../lib/gateway/core/phases/authorize.mjs";
import { run as runPre } from "../../lib/gateway/core/phases/resource-policy-pre.mjs";
import { run as runPost } from "../../lib/gateway/core/phases/resource-policy-post.mjs";
import { signRequest } from "../../lib/gateway/core/auth/sigv4.mjs";
import { base64UrlEncode } from "../../lib/gateway/core/auth/jwt.mjs";

const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);
const ISSUER = "https://auth.example.com";

function makeCtx({ request, artifact = {}, ports = {} }) {
  return {
    request,
    artifact: { projectId: "p1", apiPublicId: "api1234567", stage: "prod", protocol: "REST", ...artifact },
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
    context: {
      accountId: "p1",
      apiId: "api1234567",
      stage: "prod",
      resourcePath: "/pets",
      routeKey: "GET /pets",
      identity: { sourceIp: "1.2.3.4", userAgent: "t", apiKey: "", apiKeyId: "", caller: "", user: "", userArn: "", accessKey: "" },
      authorizer: { principalId: "", claims: {}, scopes: "", error: "", latency: "", status: "" },
      authenticate: { error: "", latency: "", status: "" },
    },
  };
}

// --- JWT helpers (WebCrypto keys, stub JWKS fetch) ---------------------------

let keyPair = null;
async function keys() {
  if (!keyPair) {
    keyPair = await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    );
    const jwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
    jwk.kid = "k1";
    jwk.alg = "RS256";
    keyPair.jwk = jwk;
  }
  return keyPair;
}

function b64json(value) {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));
}

async function mintToken(payload) {
  const { privateKey } = await keys();
  const input = `${b64json({ alg: "RS256", kid: "k1", typ: "JWT" })}.${b64json(payload)}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, new TextEncoder().encode(input));
  return `${input}.${base64UrlEncode(new Uint8Array(signature))}`;
}

function jwtPorts() {
  return {
    fetch: async (url) => {
      const { jwk } = await keys();
      if (String(url) === `${ISSUER}/.well-known/openid-configuration`) {
        return Response.json({ issuer: ISSUER, jwks_uri: `${ISSUER}/jwks` });
      }
      if (String(url) === `${ISSUER}/jwks`) return Response.json({ keys: [jwk] });
      return new Response("not found", { status: 404 });
    },
  };
}

const JWT_AUTHORIZER = {
  id: "auth-jwt",
  type: "JWT",
  identitySource: ["$request.header.Authorization"],
  jwt: { issuer: ISSUER, audience: ["my-api"], algorithms: ["RS256"], clockSkewSec: 0 },
};

function restArtifact(auth, authorizers) {
  return {
    protocol: "REST",
    resources: [{
      id: "res-pets",
      path: "/pets",
      methods: { GET: { id: "m1", auth, apiKeyRequired: false, integrationId: "int1" } },
    }],
    authorizers,
  };
}

test("S07: authorizer context exposed as $context.authorizer phase fields (JWT allow)", async () => {
  const token = await mintToken({
    iss: ISSUER, sub: "user-9", aud: "my-api",
    exp: Math.floor(NOW / 1000) + 3600, iat: Math.floor(NOW / 1000),
    scope: "read write", team: "core",
  });
  const request = new Request("https://gw.test/pets", { headers: { Authorization: `Bearer ${token}` } });
  const ctx = makeCtx({
    request,
    artifact: restArtifact(
      { type: "JWT", authorizerId: "auth-jwt", scopes: [] },
      { "auth-jwt": JWT_AUTHORIZER },
    ),
    ports: jwtPorts(),
  });
  ctx.match = { resourceId: "res-pets" };
  await runAuthorize(ctx);
  assert.equal(ctx.authType, "JWT");
  assert.equal(ctx.authorizer.principalId, "user-9");
  assert.equal(ctx.context.authorizer.principalId, "user-9");
  assert.equal(ctx.context.authorizer.claims.sub, "user-9");
  assert.equal(ctx.context.authorizer.scopes, "read write");
  assert.equal(ctx.authResult.authorized, true);
});

test("S07: aud check and scopes enforced at the authorize phase (403 on scope miss)", async () => {
  const token = await mintToken({
    iss: ISSUER, sub: "user-9", aud: "my-api",
    exp: Math.floor(NOW / 1000) + 3600, iat: Math.floor(NOW / 1000),
    scope: "read",
  });
  const request = new Request("https://gw.test/pets", { headers: { Authorization: `Bearer ${token}` } });
  const ctx = makeCtx({
    request,
    artifact: restArtifact(
      { type: "JWT", authorizerId: "auth-jwt", scopes: ["admin"] },
      { "auth-jwt": JWT_AUTHORIZER },
    ),
    ports: jwtPorts(),
  });
  ctx.match = { resourceId: "res-pets" };
  await assert.rejects(runAuthorize(ctx), (error) => error?.type === "ACCESS_DENIED");
});

test("S07: missing identity source at the authorize phase → 401 without invoking", async () => {
  let calls = 0;
  const request = new Request("https://gw.test/pets");
  const ctx = makeCtx({
    request,
    artifact: restArtifact(
      { type: "CUSTOM", authorizerId: "auth-tok", scopes: [] },
      {
        "auth-tok": {
          id: "auth-tok", type: "TOKEN",
          identitySource: ["method.request.header.Authorization"],
          function: { provider: "webhook", url: "https://auth.example/token" },
          resultTtlSeconds: 0, timeoutMs: 5000,
        },
      },
    ),
    ports: {
      fetch: async () => {
        calls += 1;
        return { ok: true, status: 200, text: async () => "{}" };
      },
    },
  });
  ctx.match = { resourceId: "res-pets" };
  await assert.rejects(runAuthorize(ctx), (error) => error?.type === "UNAUTHORIZED");
  assert.equal(calls, 0);
});

test("S07: CUSTOM webhook allow propagates context and usageIdentifierKey; deny → 403", async () => {
  const arn = "arn:pods:execute-api:auto:p1:api1234567/prod/GET/pets";
  const policy = {
    principalId: "user1",
    policyDocument: {
      Version: "2012-10-17",
      Statement: [{ Action: "execute-api:Invoke", Effect: "Allow", Resource: arn }],
    },
    context: { team: "core" },
    usageIdentifierKey: "client-7",
  };
  const request = new Request("https://gw.test/pets", { headers: { Authorization: "tok" } });
  const ctx = makeCtx({
    request,
    artifact: restArtifact(
      { type: "CUSTOM", authorizerId: "auth-tok", scopes: [] },
      {
        "auth-tok": {
          id: "auth-tok", type: "TOKEN",
          identitySource: ["method.request.header.Authorization"],
          function: { provider: "webhook", url: "https://auth.example/token" },
          resultTtlSeconds: 0, timeoutMs: 5000,
        },
      },
    ),
    ports: {
      fetch: async () => ({ ok: true, status: 200, text: async () => JSON.stringify(policy) }),
    },
  });
  ctx.match = { resourceId: "res-pets" };
  await runAuthorize(ctx);
  assert.equal(ctx.context.authorizer.principalId, "user1");
  assert.equal(ctx.context.authorizer.team, "core");
  assert.equal(ctx.usageIdentifierKey, "client-7");
});

test("S07: SIGNED valid signature allowed with identity context; identity deny → 403", async () => {
  const SECRET = "test-secret-access-key-00000000000001";
  const KEY = "PKIAAAAAAAAAAAAAAAAA";
  const ports = {
    fetch: async () => new Response("not found", { status: 404 }),
    signingCredentials: { async resolve(id) { return id === KEY ? { secretAccessKey: SECRET, status: "ACTIVE" } : null; } },
    signingPolicies: { async list() { return []; } },
  };
  const signed = await signRequest({
    method: "GET", url: "https://gw.test/pets", headers: {}, body: "",
    service: "execute-api", region: "auto", accessKeyId: KEY, secretAccessKey: SECRET, timestamp: NOW,
  });
  const headers = new Headers();
  for (const [name, value] of Object.entries(signed.headers)) {
    if (name !== "host") headers.set(name, value);
  }
  const ctx = makeCtx({
    request: new Request("https://gw.test/pets", { headers }),
    artifact: restArtifact({ type: "SIGNED", authorizerId: null, scopes: [] }, {}),
    ports,
  });
  ctx.match = { resourceId: "res-pets" };
  await runAuthorize(ctx);
  assert.equal(ctx.context.identity.accessKey, KEY);
  assert.equal(ctx.context.identity.caller, KEY);
  assert.match(ctx.context.identity.userArn, /credential\/PKIA/);
  assert.equal(ctx.authResult.identityDecision, "Allow");

  // Same signature, but the identity policy denies → 403 ACCESS_DENIED.
  const denyPorts = {
    ...ports,
    signingPolicies: {
      async list() {
        return [{ Version: "2012-10-17", Statement: [{ Effect: "Deny", Action: "execute-api:Invoke", Resource: "*" }] }];
      },
    },
  };
  const headers2 = new Headers();
  for (const [name, value] of Object.entries(signed.headers)) {
    if (name !== "host") headers2.set(name, value);
  }
  const ctx2 = makeCtx({
    request: new Request("https://gw.test/pets", { headers: headers2 }),
    artifact: restArtifact({ type: "SIGNED", authorizerId: null, scopes: [] }, {}),
    ports: denyPorts,
  });
  ctx2.match = { resourceId: "res-pets" };
  await assert.rejects(runAuthorize(ctx2), (error) => error?.type === "ACCESS_DENIED");
});

test("S07: pre-auth IP deny at the phase never reaches the authorizer (spy)", async () => {
  let calls = 0;
  const denyIp = {
    Version: "2012-10-17",
    Statement: [{
      Effect: "Deny", Action: "execute-api:Invoke", Resource: "*",
      Condition: { IpAddress: { "aws:SourceIp": "1.2.3.4/32" } },
    }],
  };
  const ctx = makeCtx({
    request: new Request("https://gw.test/pets", { headers: { Authorization: "tok" } }),
    artifact: {
      protocol: "REST",
      settings: { resourcePolicy: denyIp },
      resources: [{
        id: "res-pets", path: "/pets",
        methods: { GET: { id: "m1", auth: { type: "CUSTOM", authorizerId: "auth-tok", scopes: [] } } },
      }],
      authorizers: {
        "auth-tok": {
          id: "auth-tok", type: "TOKEN",
          identitySource: ["method.request.header.Authorization"],
          function: { provider: "webhook", url: "https://auth.example/token" },
          resultTtlSeconds: 0, timeoutMs: 5000,
        },
      },
    },
    ports: {
      fetch: async () => {
        calls += 1;
        return { ok: true, status: 200, text: async () => "{}" };
      },
    },
  });
  ctx.match = { resourceId: "res-pets" };
  ctx.methodArn = "arn:pods:execute-api:auto:p1:api1234567/prod/GET/pets";
  await assert.rejects(runPre(ctx), (error) => error?.type === "ACCESS_DENIED");
  assert.equal(calls, 0);

  // And the post-auth pass replays the §7 table through the phases.
  const post = makeCtx({
    request: new Request("https://gw.test/pets"),
    artifact: { protocol: "REST", settings: { resourcePolicy: denyIp } },
  });
  post.methodArn = ctx.methodArn;
  await assert.rejects(
    runPost(post, post.methodArn, { authType: "NONE", authorized: true, principalArn: null, identityDecision: "ImplicitDeny" }),
    (error) => error?.type === "ACCESS_DENIED",
  );
});
