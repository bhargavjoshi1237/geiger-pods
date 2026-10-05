import assert from "node:assert/strict";
import test from "node:test";
import { createHmac, createPrivateKey, createPublicKey, createSign, generateKeyPairSync } from "node:crypto";
import {
  claimsForContext,
  decodeJwt,
  extractJwtToken,
  scopesFromClaims,
  stripBearer,
  verifyJwt,
} from "../../lib/gateway/core/auth/jwt.mjs";
import { MemoryKvStore } from "../../lib/gateway/state/memory-kv.mjs";
import { GatewayError } from "../../lib/gateway/core/errors.mjs";

const ISSUER = "https://auth.example.test";
const NOW = Date.UTC(2026, 7, 30, 12, 0, 0);

const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

function jwk(kid) {
  return { ...createPublicKey(publicKey).export({ format: "jwk" }), kid, alg: "RS256", use: "sig" };
}

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function mint(payload, { kid = "k1", alg = "RS256" } = {}) {
  const header = { alg, kid, typ: "JWT" };
  const input = `${base64UrlJson(header)}.${base64UrlJson(payload)}`;
  const signature = createSign("RSA-SHA256").update(input).sign(createPrivateKey(privateKey)).toString("base64url");
  return `${input}.${signature}`;
}

function hmacToken(payload) {
  const input = `${base64UrlJson({ alg: "HS256", typ: "JWT" })}.${base64UrlJson(payload)}`;
  return `${input}.${createHmac("sha256", "secret").update(input).digest("base64url")}`;
}

function claims(overrides = {}) {
  return {
    iss: ISSUER, sub: "user-1", aud: "my-api",
    exp: Math.floor(NOW / 1000) + 3600, iat: Math.floor(NOW / 1000),
    ...overrides,
  };
}

function stubPorts({ kids = ["k1"], calls = null, clock = null } = {}) {
  const sharedClock = clock ?? { now: () => NOW };
  const kv = new MemoryKvStore({ clock: sharedClock });
  return {
    kv,
    clock: sharedClock,
    fetch: async (url) => {
      if (calls) calls.count += 1;
      if (String(url).endsWith("/.well-known/openid-configuration")) {
        return { ok: true, json: async () => ({ jwks_uri: `${ISSUER}/jwks` }) };
      }
      if (String(url) === `${ISSUER}/jwks`) {
        if (calls) calls.jwks += 1;
        return { ok: true, json: async () => ({ keys: kids.map(jwk) }) };
      }
      throw new Error(`unexpected fetch ${url}`);
    },
  };
}

const AUTHORIZER = { issuer: ISSUER, audience: ["my-api"], algorithms: ["RS256"], clockSkewSec: 0 };

test("S07: JWT valid token allowed; wrong iss, expired, wrong aud, alg none, HS256 rejected 401; missing token 401", async () => {
  const ports = stubPorts();
  const ok = await verifyJwt({ token: `Bearer ${mint(claims())}`, authorizer: AUTHORIZER, ports });
  assert.equal(ok.principalId, "user-1");
  assert.deepEqual(ok.scopes, []);
  assert.equal(ok.claims.iss, ISSUER);

  await assert.rejects(verifyJwt({ token: mint(claims({ iss: "https://evil.test" })), authorizer: AUTHORIZER, ports }),
    (error) => error instanceof GatewayError && error.type === "UNAUTHORIZED" && error.statusCode === 401);
  await assert.rejects(verifyJwt({ token: mint(claims({ exp: Math.floor(NOW / 1000) - 10 })), authorizer: AUTHORIZER, ports }),
    (error) => error instanceof GatewayError && error.type === "UNAUTHORIZED");
  await assert.rejects(verifyJwt({ token: mint(claims({ aud: "other" })), authorizer: AUTHORIZER, ports }),
    (error) => error instanceof GatewayError && error.type === "UNAUTHORIZED");
  // alg none and HS256 are never accepted.
  const noneToken = `${base64UrlJson({ alg: "none" })}.${base64UrlJson(claims())}.`;
  await assert.rejects(verifyJwt({ token: noneToken, authorizer: AUTHORIZER, ports }),
    (error) => error instanceof GatewayError && error.type === "UNAUTHORIZED");
  await assert.rejects(
    verifyJwt({ token: hmacToken(claims()), authorizer: { ...AUTHORIZER, algorithms: ["HS256", "RS256"] }, ports }),
    (error) => error instanceof GatewayError && error.type === "UNAUTHORIZED");
  await assert.rejects(verifyJwt({ token: null, authorizer: AUTHORIZER, ports }),
    (error) => error instanceof GatewayError && error.type === "UNAUTHORIZED");
  await assert.rejects(verifyJwt({ token: "   ", authorizer: AUTHORIZER, ports }),
    (error) => error instanceof GatewayError && error.type === "UNAUTHORIZED");
  // Missing exp is rejected (exp required).
  const { exp: _dropped, ...noExp } = claims();
  await assert.rejects(verifyJwt({ token: mint(noExp), authorizer: AUTHORIZER, ports }),
    (error) => error instanceof GatewayError && error.type === "UNAUTHORIZED");
});

test("S07: aud check passes on client_id claim; scopes require at least one listed scope else 403", async () => {
  const ports = stubPorts();
  const viaClientId = await verifyJwt({
    token: mint({ ...claims({ aud: "other" }), client_id: "my-api" }),
    authorizer: AUTHORIZER, ports,
  });
  assert.equal(viaClientId.principalId, "user-1");
  const arrayAud = await verifyJwt({
    token: mint(claims({ aud: ["x", "my-api"] })), authorizer: AUTHORIZER, ports,
  });
  assert.equal(arrayAud.principalId, "user-1");

  await assert.rejects(
    verifyJwt({ token: mint(claims({ scope: "read write" })), authorizer: AUTHORIZER, ports, requiredScopes: ["admin"] }),
    (error) => error instanceof GatewayError && error.type === "ACCESS_DENIED" && error.statusCode === 403);
  const scoped = await verifyJwt({
    token: mint(claims({ scope: "read admin" })), authorizer: AUTHORIZER, ports, requiredScopes: ["admin", "other"],
  });
  assert.deepEqual(scoped.scopes, ["read", "admin"]);
  const scp = await verifyJwt({
    token: mint({ ...claims(), scp: ["admin"] }), authorizer: AUTHORIZER, ports, requiredScopes: ["admin"],
  });
  assert.deepEqual(scp.scopes, ["admin"]);
  assert.deepEqual(scopesFromClaims({}), []);
});

test("S07: unknown kid triggers single JWKS refetch; second unknown kid within a minute does not refetch", async () => {
  let nowMs = NOW;
  const clock = { now: () => nowMs };
  const calls = { count: 0, jwks: 0 };
  const ports = stubPorts({ calls, clock });
  // Prime the cache with a valid token.
  await verifyJwt({ token: mint(claims()), authorizer: AUTHORIZER, ports });
  assert.equal(calls.jwks, 1);

  // Unknown kid → one refetch (jwks fetched again), still unknown → 401.
  await assert.rejects(
    verifyJwt({ token: mint(claims(), { kid: "nope-1" }), authorizer: AUTHORIZER, ports }),
    (error) => error instanceof GatewayError && error.type === "UNAUTHORIZED");
  assert.equal(calls.jwks, 2);
  // A different unknown kid within the minute: no further refetch.
  await assert.rejects(
    verifyJwt({ token: mint(claims(), { kid: "nope-2" }), authorizer: AUTHORIZER, ports }),
    (error) => error instanceof GatewayError && error.type === "UNAUTHORIZED");
  assert.equal(calls.jwks, 2);
  // After the minute passes, an unknown kid refetches again.
  nowMs += 61 * 1000;
  await assert.rejects(
    verifyJwt({ token: mint(claims(), { kid: "nope-3" }), authorizer: AUTHORIZER, ports }),
    (error) => error instanceof GatewayError && error.type === "UNAUTHORIZED");
  assert.equal(calls.jwks, 3);
  // Cached JWKS still serves known kids without network.
  const before = calls.jwks;
  await verifyJwt({ token: mint(claims()), authorizer: AUTHORIZER, ports });
  assert.equal(calls.jwks, before);
});

test("S07: Bearer stripping is case-insensitive; token extraction and debugger decode", () => {
  assert.equal(stripBearer("Bearer abc"), "abc");
  assert.equal(stripBearer("bearer abc"), "abc");
  assert.equal(stripBearer("BEARER abc"), "abc");
  assert.equal(stripBearer("abc"), "abc");
  const request = new Request("https://api.example/", { headers: { Authorization: "Bearer tok.1" } });
  assert.equal(extractJwtToken({}, { request }), "tok.1");
  assert.equal(extractJwtToken({ identitySource: ["$request.header.Authorization"] }, { request }), "tok.1");
  assert.equal(extractJwtToken({}, { request: new Request("https://api.example/") }), null);
  const decoded = decodeJwt(mint(claims()));
  assert.equal(decoded.payload.sub, "user-1");
  assert.equal(decoded.header.alg, "RS256");
  assert.throws(() => decodeJwt("not-a-jwt"), (error) => error instanceof GatewayError);
  assert.deepEqual(claimsForContext({ s: "x", n: 1, b: true, a: [1] }), { s: "x", n: "1", b: "true", a: "[1]" });
});
