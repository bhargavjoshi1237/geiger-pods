import assert from "node:assert/strict";
import test from "node:test";

import {
  applyCorsToResponse,
  handlePreflight,
  isPreflightRequest,
  validateCorsConfig,
} from "../../lib/gateway/core/processing/cors.mjs";

const CORS = {
  allowOrigins: ["https://example.com"],
  allowMethods: ["GET", "POST"],
  allowHeaders: ["Content-Type", "Authorization"],
  exposeHeaders: ["X-Trace"],
  maxAge: 600,
  allowCredentials: true,
};

function preflight(origin = "https://example.com", method = "GET") {
  return new Request("https://gw.test/items", {
    method: "OPTIONS",
    headers: { origin, "access-control-request-method": method },
  });
}

test("S06: HTTP preflight answered 204 without calling authorizer or integration; backend CORS headers replaced; * + credentials rejected", async () => {
  // Preflight detection: OPTIONS + Origin + Access-Control-Request-Method.
  assert.equal(isPreflightRequest(preflight()), true);
  assert.equal(isPreflightRequest(new Request("https://gw.test/items", { method: "OPTIONS" })), false);
  assert.equal(isPreflightRequest(new Request("https://gw.test/items", { headers: { origin: "https://example.com" } })), false);

  // The gateway answers the preflight itself: phase 6 returns before any
  // authorizer or integration runs (no route lookup needed).
  const answered = handlePreflight(preflight(), CORS);
  assert.ok(answered instanceof Response);
  assert.equal(answered.status, 204);
  assert.equal(answered.headers.get("access-control-allow-origin"), "https://example.com");
  assert.ok((answered.headers.get("access-control-allow-methods") ?? "").includes("GET"));
  assert.equal(answered.headers.get("access-control-allow-credentials"), "true");
  assert.equal(answered.headers.get("access-control-max-age"), "600");
  assert.equal(answered.headers.get("vary"), "Origin");

  // A non-preflight OPTIONS goes through normal routing (null = not handled).
  assert.equal(handlePreflight(new Request("https://gw.test/items", { method: "OPTIONS" }), CORS), null);

  // Disallowed origin: still 204 (preflight answered) but no CORS headers;
  // the actual request itself proceeds and browsers enforce the policy.
  const denied = handlePreflight(preflight("https://evil.test"), CORS);
  assert.equal(denied.status, 204);
  assert.equal(denied.headers.get("access-control-allow-origin"), null);

  // Actual responses: configured headers replace backend CORS headers.
  const backend = new Response('{"ok":true}', {
    headers: {
      "access-control-allow-origin": "https://backend.internal",
      "access-control-expose-headers": "X-Backend",
      "x-trace": "1",
    },
  });
  const outgoing = applyCorsToResponse(
    new Request("https://gw.test/items", { headers: { origin: "https://example.com" } }),
    backend,
    CORS,
  );
  assert.equal(outgoing.headers.get("access-control-allow-origin"), "https://example.com");
  assert.equal(outgoing.headers.get("access-control-expose-headers"), "X-Trace");
  assert.equal(outgoing.headers.get("x-trace"), "1");
  assert.ok((outgoing.headers.get("vary") ?? "").includes("Origin"));

  // `*` echoes as `*` only without credentials.
  const star = applyCorsToResponse(
    new Request("https://gw.test/items", { headers: { origin: "https://any.test" } }),
    new Response("ok"),
    { ...CORS, allowOrigins: ["*"], allowCredentials: false },
  );
  assert.equal(star.headers.get("access-control-allow-origin"), "*");

  // `*` + credentials is rejected at validation (AWS parity).
  assert.deepEqual(validateCorsConfig({ ...CORS, allowOrigins: ["*"], allowCredentials: true }), [
    "cors: allowCredentials must not be true when allowOrigins contains *",
  ]);
  assert.deepEqual(validateCorsConfig(CORS), []);

  // Subdomain wildcards are a Pods extension, off unless enabled.
  const wildcard = { ...CORS, allowOrigins: ["https://*.example.com"] };
  assert.equal(handlePreflight(preflight("https://app.example.com"), wildcard)?.headers.get("access-control-allow-origin"), null);
  const enabled = handlePreflight(preflight("https://app.example.com"), wildcard, { features: { corsWildcardSubdomains: true } });
  assert.equal(enabled?.headers.get("access-control-allow-origin"), "https://app.example.com");
});
