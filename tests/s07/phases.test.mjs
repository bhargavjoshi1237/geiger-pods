import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync, createPrivateKey, createPublicKey, createSign } from "node:crypto";
import { compile, setPlaintextCache, clearPlaintextCache } from "../../lib/gateway/artifact/compile.mjs";
import { run as runAuthorize } from "../../lib/gateway/core/phases/authorize.mjs";
import { run as runPre } from "../../lib/gateway/core/phases/resource-policy-pre.mjs";
import { run as runPost } from "../../lib/gateway/core/phases/resource-policy-post.mjs";
import { signRequest } from "../../lib/gateway/core/auth/sigv4.mjs";
import { MemoryKvStore } from "../../lib/gateway/state/memory-kv.mjs";
import { GatewayError } from "../../lib/gateway/core/errors.mjs";

// NOTE: full-pipeline (`handle()`) coverage lives in `pipeline.test.mjs`,
// gated on the S10 observe barrel (currently mid-refactor: `observe/index`
// imports `signPayload`, which `sinks.mjs` no longer exports — every
// `handle()` caller fails at import). These phase-level tests drive the S07
// phases directly with hand-built contexts so authorization behavior is
// verified independently of S10.

const ISSUER = "https://auth.example.test";
const NOW = Date.UTC(2026, 7, 30, 12, 0, 0);
const SECRET = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";

const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const PUB_JWK = {
  ...createPublicKey(publicKey).export({ format: "jwk" }),
  kid: "k1", alg: "RS256", use: "sig",
};

function b64json(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function mint(payload, kid = "k1") {
  const input = `${b64json({ alg: "RS256", kid, typ: "JWT" })}.${b64json(payload)}`;
  return `${input}.${createSign("RSA-SHA256").update(input).sign(createPrivateKey(privateKey)).toString("base64url")}`;
}

function jwtClaims(overrides = {}) {
  return {
    iss: ISSUER, sub: "user-1", aud: "my-api", scope: "read",
    exp: Math.floor(NOW / 1000) + 3600, iat: Math.floor(NOW / 1000),
    ...overrides,
  };
}

function restArtifact({ methods, authorizers = [], resourcePolicy = null }) {
  const draft = {
    projectId: "proj-1", apiId: "api-1", apiPublicId: "a1b2c3d4e5", protocol: "REST",
    settings: resourcePolicy ? { resourcePolicy } : {},
    resources: [{ id: "res1", path: "/pets" }],
    methods,
    integrations: [{ id: "int1", type: "MOCK" }],
    authorizers,
  };
  const { artifact, errors } = compile(draft);
  assert.equal(errors.length, 0, JSON.stringify(errors));
  return { ...artifact, stage: "prod" };
}

function mockMethods(auth) {
  return [
    { id: "m1", resourceId: "res1", httpMethod: "GET", ...auth, integrationId: "int1" },
    { id: "m2", resourceId: "res1", httpMethod: "POST", ...auth, integrationId: "int1" },
  ];
}

const GET_MATCH = { resourceId: "res1", resourcePath: "/pets", methodId: "m1", httpMethod: "GET", pathParameters: {} };
const POST_MATCH = { resourceId: "res1", resourcePath: "/pets", methodId: "m2", httpMethod: "POST", pathParameters: {} };

function testCtx({ request, artifact, ports, match = GET_MATCH, sourceIp = "1.2.3.4" }) {
  return {
    request, artifact, ports, match,
    pathParameters: match?.pathParameters ?? {},
    stageVariables: {},
    context: {
      requestId: "req-1",
      stage: "prod",
      apiId: "a1b2c3d4e5",
      resourcePath: match?.resourcePath ?? "",
      routeKey: `GET ${match?.resourcePath ?? ""}`,
      identity: {
        sourceIp, userAgent: "test", apiKey: "", apiKeyId: "",
        caller: "", user: "", userArn: "", accessKey: "",
      },
      authorizer: { principalId: "", claims: {}, scopes: "" },
      authenticate: { error: "", latency: "", status: "" },
    },
  };
}

function jwksFetch() {
  return async (url) => {
    if (String(url).endsWith("/.well-known/openid-configuration")) {
      return { ok: true, json: async () => ({ jwks_uri: `${ISSUER}/jwks` }) };
    }
    if (String(url) === `${ISSUER}/jwks`) {
      return { ok: true, json: async () => ({ keys: [PUB_JWK] }) };
    }
    throw new Error(`unexpected fetch ${url}`);
  };
}

function basePorts(extra = {}) {
  const clock = { now: () => NOW };
  return {
    kv: new MemoryKvStore({ clock }),
    clock,
    fetch: jwksFetch(),
    secrets: { async resolve() { throw new Error("no secrets"); } },
    log() {},
    ...extra,
  };
}

const JWT_AUTHORIZER = {
  id: "jwt1", name: "jwt", type: "JWT",
  identity_source: ["method.request.header.Authorization"],
  jwt: { issuer: ISSUER, audience: ["my-api"], algorithms: ["RS256"] },
};

async function authorizeOnly({ request, artifact, ports, match }) {
  const ctx = testCtx({ request, artifact, ports, match });
  await runPre(ctx);
  await runAuthorize(ctx);
  await runPost(ctx);
  return ctx;
}

test("S07: JWT through the phases — valid token allowed, invalid/missing 401", async () => {
  const artifact = restArtifact({
    methods: mockMethods({ authorizationType: "JWT", authorizerId: "jwt1" }),
    authorizers: [JWT_AUTHORIZER],
  });
  const ctx = await authorizeOnly({
    request: new Request("http://localhost/pets", { headers: { Authorization: `Bearer ${mint(jwtClaims())}` } }),
    artifact, ports: basePorts(),
  });
  assert.equal(ctx.authResult.authType, "JWT");
  assert.equal(ctx.authResult.authorized, true);
  assert.equal(ctx.context.authorizer.principalId, "user-1");

  await assert.rejects(
    authorizeOnly({ request: new Request("http://localhost/pets"), artifact, ports: basePorts() }),
    (error) => error instanceof GatewayError && error.type === "UNAUTHORIZED",
  );
  await assert.rejects(
    authorizeOnly({
      request: new Request("http://localhost/pets", { headers: { Authorization: mint(jwtClaims({ exp: Math.floor(NOW / 1000) - 5 })) } }),
      artifact, ports: basePorts(),
    }),
    (error) => error instanceof GatewayError && error.type === "UNAUTHORIZED",
  );
});

test("S07: authorize phase sets $context.authorizer claims/scopes/principalId", async () => {
  const artifact = restArtifact({
    methods: mockMethods({ authorizationType: "JWT", authorizerId: "jwt1", authorizationScopes: ["admin"] }),
    authorizers: [JWT_AUTHORIZER],
  });
  const ctx = await authorizeOnly({
    request: new Request("http://localhost/pets", { headers: { Authorization: mint(jwtClaims({ scope: "read admin" })) } }),
    artifact, ports: basePorts(),
  });
  assert.equal(ctx.context.authorizer.principalId, "user-1");
  assert.equal(ctx.context.authorizer.claims.sub, "user-1");
  assert.equal(ctx.context.authorizer.scopes, "read admin");
  assert.equal(ctx.authorizer.principalId, "user-1");
});

test("S07: pre-auth IP deny never invokes authorizer (spy)", async () => {
  const policy = {
    Version: "2012-10-17",
    Statement: [{
      Effect: "Deny", Action: "execute-api:Invoke", Resource: "*",
      Condition: { IpAddress: { "aws:SourceIp": "10.0.0.0/8" } },
    }],
  };
  const artifact = restArtifact({
    methods: mockMethods({ authorizationType: "CUSTOM", authorizerId: "c1" }),
    authorizers: [{
      id: "c1", name: "c", type: "TOKEN",
      identity_source: ["method.request.header.Authorization"],
      function: { provider: "webhook", url: "https://auth.example/token" },
    }],
    resourcePolicy: policy,
  });
  let authorizerCalls = 0;
  const ports = basePorts({
    fetch: async (url) => {
      if (String(url).startsWith("https://auth.example/")) authorizerCalls += 1;
      return jwksFetch()(url);
    },
  });
  const ctx = testCtx({
    request: new Request("http://localhost/pets", { headers: { "x-forwarded-for": "10.9.9.9", Authorization: "tok" } }),
    artifact, ports, sourceIp: "10.9.9.9",
  });
  await assert.rejects(runPre(ctx), (error) => {
    assert.equal(error.type, "ACCESS_DENIED");
    assert.match(error.message, /User: anonymous is not authorized/);
    return true;
  });
  assert.equal(authorizerCalls, 0);
});

test("S07: NONE + implicit policy denies; CUSTOM allow + implicit policy allows", async () => {
  const policy = {
    Version: "2012-10-17",
    Statement: [{ Effect: "Allow", Action: "execute-api:Invoke", Resource: "arn:pods:execute-api:auto:proj-1:a1b2c3d4e5/prod/GET/other" }],
  };
  const noneArtifact = restArtifact({
    methods: mockMethods({ authorizationType: "NONE" }),
    resourcePolicy: policy,
  });
  await assert.rejects(
    authorizeOnly({ request: new Request("http://localhost/pets"), artifact: noneArtifact, ports: basePorts() }),
    (error) => error instanceof GatewayError && error.type === "ACCESS_DENIED",
  );

  const allowOutput = {
    principalId: "u1",
    policyDocument: {
      Version: "2012-10-17",
      Statement: [{ Action: "execute-api:Invoke", Effect: "Allow", Resource: "*" }],
    },
    context: {},
  };
  const customArtifact = restArtifact({
    methods: mockMethods({ authorizationType: "CUSTOM", authorizerId: "c1" }),
    authorizers: [{
      id: "c1", name: "c", type: "TOKEN",
      identity_source: ["method.request.header.Authorization"],
      function: { provider: "webhook", url: "https://auth.example/token" },
    }],
    resourcePolicy: policy,
  });
  const customPorts = basePorts({
    fetch: async () => ({ ok: true, status: 200, text: async () => JSON.stringify(allowOutput) }),
  });
  const ctx = await authorizeOnly({
    request: new Request("http://localhost/pets", { headers: { Authorization: "tok" } }),
    artifact: customArtifact, ports: customPorts,
  });
  assert.equal(ctx.authResult.authorized, true);
});

const ALLOW_INVOKE = { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "execute-api:Invoke", Resource: "*" }] };

test("S07: signed request verifies; tampered body and 6-min skew fail", async () => {
  const artifact = restArtifact({ methods: mockMethods({ authorizationType: "SIGNED" }) });
  const credentialPorts = () => basePorts({
    signingCredentials: { resolve: async () => ({ secretAccessKey: SECRET, status: "ACTIVE" }) },
    signingPolicies: { list: async () => [ALLOW_INVOKE] },
  });
  const good = await signRequest({
    method: "POST", url: "http://localhost/pets",
    headers: { "content-type": "application/json" }, body: '{"a":1}',
    service: "execute-api", region: "auto",
    accessKeyId: "PKIAEXAMPLEKEY01", secretAccessKey: SECRET, timestamp: NOW,
  });
  const ctx = await authorizeOnly({
    request: new Request("http://localhost/pets", { method: "POST", headers: good.headers, body: '{"a":1}' }),
    artifact, ports: credentialPorts(), match: POST_MATCH,
  });
  assert.equal(ctx.authResult.authType, "SIGNED");
  assert.equal(ctx.context.identity.accessKey, "PKIAEXAMPLEKEY01");
  assert.equal(ctx.context.identity.caller, "PKIAEXAMPLEKEY01");

  await assert.rejects(
    authorizeOnly({
      request: new Request("http://localhost/pets", { method: "POST", headers: good.headers, body: '{"a":2}' }),
      artifact, ports: credentialPorts(), match: POST_MATCH,
    }),
    (error) => error instanceof GatewayError && error.type === "INVALID_SIGNATURE",
  );
  const old = await signRequest({
    method: "GET", url: "http://localhost/pets",
    headers: {}, body: "",
    service: "execute-api", region: "auto",
    accessKeyId: "PKIAEXAMPLEKEY01", secretAccessKey: SECRET, timestamp: NOW - 6 * 60 * 1000,
  });
  await assert.rejects(
    authorizeOnly({
      request: new Request("http://localhost/pets", { headers: old.headers }),
      artifact, ports: credentialPorts(),
    }),
    (error) => error instanceof GatewayError && error.type === "INVALID_SIGNATURE",
  );
});

test("S07: compile snapshots policy + authorizers; artifact carries no secret plaintext", () => {
  setPlaintextCache(["super-secret-plaintext-xyz"]);
  try {
    const policy = {
      Version: "2012-10-17",
      Statement: [{ Effect: "Allow", Action: "execute-api:Invoke", Resource: "*" }],
    };
    const draft = {
      projectId: "proj-1", apiId: "api-1", apiPublicId: "a1b2c3d4e5", protocol: "REST",
      settings: { resourcePolicy: policy },
      resources: [{ id: "res1", path: "/pets" }],
      methods: [{ id: "m1", resourceId: "res1", httpMethod: "GET", authorizationType: "CUSTOM", authorizerId: "c1", integrationId: "int1" }],
      integrations: [{ id: "int1", type: "MOCK" }],
      authorizers: [{
        id: "c1", name: "c", type: "TOKEN",
        identity_source: ["method.request.header.Authorization"],
        function: { provider: "webhook", url: "https://auth.example/t", secretRef: "secret:wh-1" },
        credentialsRef: "secret:cred-1",
      }],
    };
    const { artifact, errors } = compile(draft);
    assert.equal(errors.length, 0, JSON.stringify(errors));
    assert.deepEqual(artifact.settings.resourcePolicy, policy);
    assert.equal(artifact.authorizers.c1.resultTtlSeconds, 300);
    assert.equal(artifact.authorizers.c1.function.secretRef, "secret:wh-1");
    assert.ok(!JSON.stringify(artifact).includes("super-secret-plaintext-xyz"));
  } finally {
    clearPlaintextCache();
  }
});

test("S07: CUSTOM cached gotcha at phase level (GET allow, POST deny, one invoke)", async () => {
  const getOnly = {
    principalId: "u1",
    policyDocument: {
      Version: "2012-10-17",
      Statement: [{
        Action: "execute-api:Invoke", Effect: "Allow",
        Resource: "arn:pods:execute-api:auto:proj-1:a1b2c3d4e5/prod/GET/pets",
      }],
    },
    context: {},
  };
  const artifact = restArtifact({
    methods: mockMethods({ authorizationType: "CUSTOM", authorizerId: "c1" }),
    authorizers: [{
      id: "c1", name: "c", type: "TOKEN",
      identity_source: ["method.request.header.Authorization"],
      function: { provider: "webhook", url: "https://auth.example/token" },
      result_ttl_seconds: 300,
    }],
  });
  let calls = 0;
  const ports = basePorts({
    fetch: async () => {
      calls += 1;
      return { ok: true, status: 200, text: async () => JSON.stringify(getOnly) };
    },
  });
  const headers = { Authorization: "tok123" };
  const getCtx = await authorizeOnly({ request: new Request("http://localhost/pets", { headers }), artifact, ports });
  assert.equal(getCtx.authResult.authorized, true);
  await assert.rejects(
    authorizeOnly({ request: new Request("http://localhost/pets", { method: "POST", headers }), artifact, ports, match: POST_MATCH }),
    (error) => error instanceof GatewayError && error.type === "ACCESS_DENIED",
  );
  assert.equal(calls, 1);
  // Malformed authorizer output → 500 AUTHORIZER_CONFIGURATION_ERROR.
  const badPorts = basePorts({
    fetch: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ bogus: true }) }),
  });
  await assert.rejects(
    authorizeOnly({ request: new Request("http://localhost/pets", { headers }), artifact, ports: badPorts }),
    (error) => error instanceof GatewayError && error.type === "AUTHORIZER_CONFIGURATION_ERROR",
  );
});
