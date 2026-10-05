/**
 * S09 stage-cache acceptance tests (bullets 5–10).
 *
 * Engine tests run `handle()` against compiled REST artifacts with
 * HTTP_PROXY integrations pointed at the shared upstream echo fixture
 * (loopback allowed in tests); `upstream.requests.length` distinguishes hits
 * from misses. TTL tests use an injected clock (the memory KV honors it).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { compile } from "../../lib/gateway/artifact/compile.mjs";
import { handle } from "../../lib/gateway/core/index.mjs";
import { cacheKeyFor } from "../../lib/gateway/core/release/cache.mjs";
import { MemoryKvStore } from "../../lib/gateway/state/memory-kv.mjs";
import { startUpstream } from "../fixtures/upstream.mjs";
import { seededRng } from "./helper.mjs";

process.env.PODS_ALLOW_LOOPBACK = "1";

function draftWith({ methods, integrations, apiPublicId = "s09cache0001" }) {
  return {
    projectId: "proj-s09",
    apiId: "api-s09",
    apiPublicId,
    protocol: "REST",
    resources: [{ id: "res-root", path: "/" }, { id: "res-pets", path: "/pets" }],
    methods,
    integrations,
  };
}

function methodFor(httpMethod, integrationId = "int-1", overrides = {}) {
  return {
    id: `m-${httpMethod.toLowerCase()}`,
    resourceId: "res-pets",
    httpMethod,
    authorizationType: "NONE",
    authorizerId: null,
    authorizationScopes: [],
    apiKeyRequired: false,
    requestValidatorId: null,
    requestParameters: {},
    requestModels: {},
    integrationId,
    ...overrides,
  };
}

function proxyIntegration(upstreamUrl, overrides = {}) {
  return { id: "int-1", type: "HTTP_PROXY", uri: `${upstreamUrl}/echo`, timeoutMs: 5000, ...overrides };
}

function compileArtifact(draft, { stageCache = null, clock = null } = {}) {
  const { artifact, errors } = compile(draft);
  assert.equal(errors.length, 0, `fixture must compile: ${errors[0]?.message}`);
  return {
    artifact: {
      ...artifact,
      allowLoopback: true,
      stage: "prod",
      stageVariables: {},
      ...(stageCache ? { stageCache } : {}),
    },
    kv: new MemoryKvStore({ clock: clock ?? { now: () => Date.now() } }),
  };
}

const CACHE_ON = { enabled: true, size: "0.5", defaultTtl: 60 };

test("S09: GET cached for TTL; POST not cached by default; TTL 0 disables", async () => {
  const upstream = await startUpstream();
  try {
    const draft = draftWith({
      methods: [methodFor("GET"), methodFor("POST")],
      integrations: [proxyIntegration(upstream.url)],
    });
    const { artifact, kv } = compileArtifact(draft, { stageCache: { ...CACHE_ON } });
    const ports = { kv };
    const get = (url = "https://gw.test/pets") => handle(new Request(url), artifact, ports);

    await get();
    await get();
    assert.equal(upstream.requests.length, 1, "second GET must be a cache hit");

    // POST is never cached by default (needs an explicit override).
    await handle(new Request("https://gw.test/pets", { method: "POST", body: "a" }), artifact, ports);
    await handle(new Request("https://gw.test/pets", { method: "POST", body: "a" }), artifact, ports);
    assert.equal(upstream.requests.length, 3, "both POSTs must reach the backend");

    // TTL 0 disables caching for the method.
    const ttl0 = {
      ...artifact,
      stageCache: { ...CACHE_ON, methodSettings: { "/pets/GET": { cachingEnabled: true, cacheTtlInSeconds: 0 } } },
    };
    const kv2 = new MemoryKvStore({});
    const before = upstream.requests.length;
    await handle(new Request("https://gw.test/pets"), ttl0, { kv: kv2 });
    await handle(new Request("https://gw.test/pets"), ttl0, { kv: kv2 });
    assert.equal(upstream.requests.length, before + 2, "TTL 0 must disable caching");
  } finally {
    await upstream.close();
  }
});

test("S09: GET cached entry expires after its TTL", async () => {
  const upstream = await startUpstream();
  try {
    let now = 1_000_000;
    const clock = { now: () => now };
    const draft = draftWith({ methods: [methodFor("GET")], integrations: [proxyIntegration(upstream.url)] });
    const { artifact, kv } = compileArtifact(draft, { stageCache: { ...CACHE_ON, defaultTtl: 2 }, clock });
    const ports = { kv, clock };
    await handle(new Request("https://gw.test/pets"), artifact, ports);
    now += 1000;
    await handle(new Request("https://gw.test/pets"), artifact, ports);
    assert.equal(upstream.requests.length, 1, "within TTL must hit");
    now += 2000;
    await handle(new Request("https://gw.test/pets"), artifact, ports);
    assert.equal(upstream.requests.length, 2, "after TTL must miss");
  } finally {
    await upstream.close();
  }
});

test("S09: query param not in cache keys is ignored (same entry); listed param splits entries", async () => {
  const upstream = await startUpstream();
  try {
    // No key params: ?page is ignored.
    const draft = draftWith({ methods: [methodFor("GET")], integrations: [proxyIntegration(upstream.url)] });
    const { artifact, kv } = compileArtifact(draft, { stageCache: { ...CACHE_ON } });
    const ports = { kv };
    await handle(new Request("https://gw.test/pets?page=1"), artifact, ports);
    await handle(new Request("https://gw.test/pets?page=2"), artifact, ports);
    assert.equal(upstream.requests.length, 1, "unlisted query param must not split entries");

    // Listed param splits entries.
    const draft2 = draftWith({
      methods: [methodFor("GET")],
      integrations: [proxyIntegration(upstream.url, { cacheKeyParameters: ["method.request.querystring.page"] })],
      apiPublicId: "s09cache0002",
    });
    const compiled2 = compileArtifact(draft2, { stageCache: { ...CACHE_ON } });
    const ports2 = { kv: compiled2.kv };
    const base = upstream.requests.length;
    await handle(new Request("https://gw.test/pets?page=1"), compiled2.artifact, ports2);
    await handle(new Request("https://gw.test/pets?page=1"), compiled2.artifact, ports2);
    assert.equal(upstream.requests.length, base + 1, "same listed param must hit");
    await handle(new Request("https://gw.test/pets?page=2"), compiled2.artifact, ports2);
    assert.equal(upstream.requests.length, base + 2, "different listed param must miss");
  } finally {
    await upstream.close();
  }
});

test("S09: two different JWT subjects never receive each other's cached response (safety rule); with cacheSharedAcrossPrincipals they do", async () => {
  // Pure key guarantee: different identities → different keys by default.
  const ctxFor = (principalId, shared = false) => ({
    request: new Request("https://gw.test/pets"),
    artifact: { stage: "prod", ...(shared ? { features: { cacheSharedAcrossPrincipals: true } } : {}) },
    pathParameters: {},
    context: { authorizer: { principalId }, identity: {} },
  });
  const keyOpts = { method: "GET", resourcePath: "/pets", resourceId: "res-pets", integration: {}, stageId: "api:prod", epoch: 0 };
  const aliceKey = cacheKeyFor(ctxFor("sub-alice"), keyOpts);
  const bobKey = cacheKeyFor(ctxFor("sub-bob"), keyOpts);
  assert.notEqual(aliceKey, bobKey, "different subjects must partition keys");
  assert.equal(
    cacheKeyFor(ctxFor("sub-alice", true), keyOpts),
    cacheKeyFor(ctxFor("sub-bob", true), keyOpts),
    "opt-in shared caching must collapse identities (AWS behavior)",
  );

  // End-to-end through handle(): a JWT method partitions per subject.
  const upstream = await startUpstream();
  try {
    const keyPair = await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    );
    const jwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
    jwk.kid = "s09k1";
    jwk.alg = "RS256";
    const b64 = (value) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
    const mint = async (sub) => {
      const input = `${b64({ alg: "RS256", kid: "s09k1", typ: "JWT" })}.${b64({ iss: "https://s09.test", sub, aud: "s09", exp: 9999999999, iat: 1000 })}`;
      const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keyPair.privateKey, new TextEncoder().encode(input));
      return `${input}.${Buffer.from(signature).toString("base64url")}`;
    };
    const jwksFetch = async (url) => {
      if (String(url) === "https://s09.test/.well-known/openid-configuration") {
        return Response.json({ issuer: "https://s09.test", jwks_uri: "https://s09.test/jwks" });
      }
      if (String(url) === "https://s09.test/jwks") return Response.json({ keys: [jwk] });
      return fetch(url);
    };
    const draft = draftWith({
      methods: [methodFor("GET", "int-1", { authorizationType: "JWT", authorizerId: "auth-jwt" })],
      integrations: [proxyIntegration(upstream.url)],
      apiPublicId: "s09cache0003",
    });
    draft.authorizers = [{
      id: "auth-jwt",
      type: "JWT",
      identitySource: ["$request.header.Authorization"],
      jwt: { issuer: "https://s09.test", audience: ["s09"] },
    }];
    const { artifact, kv } = compileArtifact(draft, { stageCache: { ...CACHE_ON } });
    const ports = { kv, fetch: jwksFetch };
    const authed = async (sub) => {
      const token = await mint(sub);
      return handle(
        new Request("https://gw.test/pets", { headers: { Authorization: `Bearer ${token}` } }),
        artifact,
        ports,
      );
    };
    const first = await authed("sub-alice");
    assert.equal(first.status, 200);
    const second = await authed("sub-alice");
    assert.equal(second.status, 200);
    assert.equal(upstream.requests.length, 1, "same subject must hit");
    const third = await authed("sub-bob");
    assert.equal(third.status, 200);
    assert.equal(upstream.requests.length, 2, "different subject must miss (safety rule)");

    // Opt-in shared: bob now receives alice's cached response.
    const shared = { ...artifact, features: { cacheSharedAcrossPrincipals: true } };
    const kvShared = new MemoryKvStore({});
    const portsShared = { kv: kvShared, fetch: jwksFetch };
    const authedShared = async (sub) => {
      const token = await mint(sub);
      return handle(
        new Request("https://gw.test/pets", { headers: { Authorization: `Bearer ${token}` } }),
        shared,
        portsShared,
      );
    };
    await authedShared("sub-alice");
    const before = upstream.requests.length;
    await authedShared("sub-bob");
    assert.equal(upstream.requests.length, before, "shared opt-in must serve across subjects");
  } finally {
    await upstream.close();
  }
  void seededRng;
});

test("S09: Cache-Control max-age=0 from unauthorized caller → each strategy behaves per table; authorized SIGNED caller refreshes entry", async () => {
  const upstream = await startUpstream();
  const { signRequest } = await import("../../lib/gateway/core/auth/sigv4.mjs");
  try {
    const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);
    const SECRET = "s09-test-secret-access-key-000001";
    const KEY = "S09TESTKEY00000000001";
    const basePorts = {
      signingCredentials: { async resolve(id) { return id === KEY ? { secretAccessKey: SECRET, status: "ACTIVE" } : null; } },
    };
    const allowing = (actions) => ({
      ...basePorts,
      signingPolicies: {
        async list() {
          return [{ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: actions, Resource: "*" }] }];
        },
      },
    });
    const buildDraft = (strategy, requireAuth = true, authType = "NONE") => {
      const draft = draftWith({
        methods: [methodFor("GET", "int-1", { authorizationType: authType, authorizerId: authType === "SIGNED" ? null : undefined })],
        integrations: [proxyIntegration(upstream.url)],
      });
      if (authType === "SIGNED") {
        draft.methods[0].authorizationType = "SIGNED";
        draft.methods[0].authorizerId = null;
      }
      return { draft, strategy, requireAuth };
    };
    const compileWithCache = (draft, strategy, requireAuth) => {
      const { artifact, errors } = compile(draft);
      assert.equal(errors.length, 0);
      return {
        ...artifact,
        allowLoopback: true,
        stage: "prod",
        stageVariables: {},
        stageCache: {
          ...CACHE_ON,
          requireAuth,
          strategy,
        },
      };
    };
    // Seed the cache with one anonymous GET.
    const seed = async (artifact, kv, extraPorts = {}) => {
      await handle(new Request("https://gw.test/pets"), artifact, { kv, ...extraPorts });
    };

    // FAIL_WITH_403 → 403 ACCESS_DENIED.
    {
      const { draft } = buildDraft("FAIL_WITH_403");
      const artifact = compileWithCache(draft, "FAIL_WITH_403", true);
      const kv = new MemoryKvStore({});
      await seed(artifact, kv);
      const before = upstream.requests.length;
      const response = await handle(
        new Request("https://gw.test/pets", { headers: { "Cache-Control": "max-age=0" } }),
        artifact,
        { kv },
      );
      assert.equal(response.status, 403);
      assert.equal(upstream.requests.length, before, "denied invalidation must not reach the backend");
    }
    // SUCCEED_WITH_RESPONSE_HEADER → 200 + marker header, no refresh.
    {
      const { draft } = buildDraft("SUCCEED_WITH_RESPONSE_HEADER");
      const artifact = compileWithCache(draft, "SUCCEED_WITH_RESPONSE_HEADER", true);
      const kv = new MemoryKvStore({});
      await seed(artifact, kv);
      const before = upstream.requests.length;
      const response = await handle(
        new Request("https://gw.test/pets", { headers: { "Cache-Control": "max-age=0" } }),
        artifact,
        { kv },
      );
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("x-pods-cache-invalidation"), "unauthorized");
      assert.equal(upstream.requests.length, before + 1, "served normally (integration runs) without invalidating");
    }
    // SUCCEED_WITHOUT_RESPONSE_HEADER → 200, silent.
    {
      const { draft } = buildDraft("SUCCEED_WITHOUT_RESPONSE_HEADER");
      const artifact = compileWithCache(draft, "SUCCEED_WITHOUT_RESPONSE_HEADER", true);
      const kv = new MemoryKvStore({});
      await seed(artifact, kv);
      const response = await handle(
        new Request("https://gw.test/pets", { headers: { "Cache-Control": "max-age=0" } }),
        artifact,
        { kv },
      );
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("x-pods-cache-invalidation"), null);
    }
    // Authorized SIGNED caller refreshes the entry.
    {
      const { draft } = buildDraft("FAIL_WITH_403", true, "SIGNED");
      const artifact = compileWithCache(draft, "FAIL_WITH_403", true);
      const kv = new MemoryKvStore({});
      const policyPorts = allowing(["execute-api:Invoke", "execute-api:InvalidateCache"]);
      const testClock = { now: () => NOW };
      const signedFor = async (headers = {}) => {
        const signed = await signRequest({
          method: "GET", url: "https://gw.test/pets", headers, body: "",
          service: "execute-api", region: "auto", accessKeyId: KEY, secretAccessKey: SECRET, timestamp: NOW,
        });
        const out = new Headers();
        for (const [name, value] of Object.entries(signed.headers)) {
          if (name.toLowerCase() !== "host") out.set(name, value);
        }
        for (const [name, value] of Object.entries(headers)) out.set(name, value);
        return new Request("https://gw.test/pets", { headers: out });
      };
      const first = await handle(await signedFor(), artifact, { kv, ...policyPorts, clock: testClock });
      assert.equal(first.status, 200);
      const before = upstream.requests.length;
      const refreshed = await handle(await signedFor({ "Cache-Control": "max-age=0" }), artifact, { kv, ...policyPorts, clock: testClock });
      assert.equal(refreshed.status, 200);
      assert.equal(upstream.requests.length, before + 1, "authorized invalidation must refresh from the backend");
    }
  } finally {
    await upstream.close();
  }
});

test("S09: flush increments epoch; next request is a miss", async () => {
  const upstream = await startUpstream();
  try {
    const { flushStageCache } = await import("../../lib/control/stage-cache.mjs");
    const { createFakeDb } = await import("../s05/fake-db.mjs");
    const draft = draftWith({ methods: [methodFor("GET")], integrations: [proxyIntegration(upstream.url)] });
    const { artifact, kv } = compileArtifact(draft, { stageCache: { ...CACHE_ON } });
    const ports = { kv };
    // Point the artifact's api id at the fake stage row for epoch agreement.
    const PROJECT = "33333333-3333-4333-8333-333333333333";
    const ADMIN = { type: "user", userId: "u-admin" };
    const db = createFakeDb({ roles: { "u-admin": "admin" } });
    const api = await db.insertApi({
      project_id: PROJECT, public_id: artifact.apiPublicId, name: "s09-flush", protocol: "REST",
      api_key_source: "HEADER", binary_media_types: [], minimum_compression_size: null,
      missing_route_behavior: "aws", cors: null, resource_policy: null, route_selection_expression: null,
    });
    const stage = await db.insertStage({ project_id: PROJECT, api_id: api.id, name: "prod", deployment_id: null, variables: {} });
    void stage;
    await handle(new Request("https://gw.test/pets"), artifact, ports);
    await handle(new Request("https://gw.test/pets"), artifact, ports);
    assert.equal(upstream.requests.length, 1, "second request must hit before flush");
    const flushed = await flushStageCache(db, ADMIN, { projectId: PROJECT, apiId: api.id, stageName: "prod", kv });
    assert.equal(flushed.flushed, true);
    assert.equal(flushed.epoch, 1);
    await handle(new Request("https://gw.test/pets"), artifact, ports);
    assert.equal(upstream.requests.length, 2, "after flush the next request must miss");
  } finally {
    await upstream.close();
  }
});

test("S09: >1 MB response and Set-Cookie response not stored; encrypted cache stores no plaintext (inspect KV)", async () => {
  const upstream = await startUpstream();
  try {
    // >1 MB responses are never stored.
    const big = proxyIntegration(upstream.url);
    big.uri = `${upstream.url}/bytes/2000000`;
    const draft = draftWith({ methods: [methodFor("GET")], integrations: [big], apiPublicId: "s09big0000001" });
    const { artifact, kv } = compileArtifact(draft, { stageCache: { ...CACHE_ON } });
    const ports = { kv };
    const first = await handle(new Request("https://gw.test/pets"), artifact, ports);
    assert.equal(first.status, 200);
    await first.arrayBuffer();
    const second = await handle(new Request("https://gw.test/pets"), artifact, ports);
    assert.equal(second.status, 200);
    await second.arrayBuffer();
    assert.equal(upstream.requests.length, 2, ">1 MB responses must not be stored");

    // Set-Cookie responses are never stored (inline upstream sets a cookie).
    const { default: http } = await import("node:http");
    const cookieHits = [];
    const cookieServer = http.createServer((req, res) => {
      cookieHits.push(req.url);
      res.writeHead(200, { "content-type": "application/json", "set-cookie": "s09=1; Path=/" });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise((resolve) => cookieServer.listen(0, "127.0.0.1", resolve));
    const cookiePort = cookieServer.address().port;
    try {
      const cookie = proxyIntegration(upstream.url);
      cookie.uri = `http://127.0.0.1:${cookiePort}/cookie`;
      const draftCookie = draftWith({ methods: [methodFor("GET")], integrations: [cookie], apiPublicId: "s09cookie0001" });
      const compiledCookie = compileArtifact(draftCookie, { stageCache: { ...CACHE_ON } });
      await handle(new Request("https://gw.test/pets"), compiledCookie.artifact, { kv: compiledCookie.kv });
      await handle(new Request("https://gw.test/pets"), compiledCookie.artifact, { kv: compiledCookie.kv });
      assert.equal(cookieHits.length, 2, "Set-Cookie responses must not be stored");
    } finally {
      try {
        cookieServer.closeAllConnections();
      } catch {
        // Best-effort.
      }
      await new Promise((resolve) => cookieServer.close(resolve));
    }

    // Encrypted cache: KV holds ciphertext only.
    const draftEnc = draftWith({ methods: [methodFor("GET")], integrations: [proxyIntegration(upstream.url)], apiPublicId: "s09enc0000001" });
    const compiledEnc = compileArtifact(draftEnc, { stageCache: { ...CACHE_ON, encrypted: true } });
    const response = await handle(new Request("https://gw.test/pets?marker=plaintext-needle-9z"), compiledEnc.artifact, { kv: compiledEnc.kv });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /plaintext-needle-9z/);
    const raws = [...compiledEnc.kv._entries.values()].map((entry) => entry.value).join("\n");
    assert.ok(!raws.includes("plaintext-needle-9z"), "encrypted KV entries must not contain plaintext bodies");
    // And the entry still serves: a repeat request hits without new upstream traffic.
    const countBefore = upstream.requests.length;
    await handle(new Request("https://gw.test/pets?marker=plaintext-needle-9z"), compiledEnc.artifact, { kv: compiledEnc.kv });
    assert.equal(upstream.requests.length, countBefore, "encrypted entry must serve hits");
  } finally {
    await upstream.close();
  }
});
