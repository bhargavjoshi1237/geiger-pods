import assert from "node:assert/strict";
import test from "node:test";
import { compile, setPlaintextCache, clearPlaintextCache } from "../../lib/gateway/artifact/compile.mjs";
import { canonicalJson } from "../../lib/gateway/artifact/canonical.mjs";
import { validateStageVariables } from "../../lib/gateway/artifact/stage-variables.mjs";

function restDraft() {
  return {
    projectId: "proj-1",
    apiId: "api-1",
    apiPublicId: "a1b2c3d4e5",
    protocol: "REST",
    settings: { missingRouteBehavior: "aws" },
    resources: [{ id: "res1", path: "/pets" }],
    methods: [{
      id: "m1", resourceId: "res1", httpMethod: "GET",
      authorizationType: "NONE", authorizerId: null, authorizationScopes: [],
      apiKeyRequired: false, integrationId: "int1",
    }],
    integrations: [{ id: "int1", type: "MOCK" }],
  };
}

test("S05: compile is deterministic (same draft → same digest) and rejects a REST API without methods", () => {
  const draft = restDraft();
  const first = compile(draft);
  const second = compile(JSON.parse(JSON.stringify(draft)));
  assert.equal(first.errors.length, 0);
  assert.equal(first.artifact.digest, second.artifact.digest);
  assert.match(first.artifact.digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(canonicalJson(JSON.parse(JSON.stringify(draft))), canonicalJson(draft));

  const empty = compile({
    projectId: "proj-1", apiId: "api-1", apiPublicId: "a1b2c3d4e5",
    protocol: "REST", resources: [], methods: [], integrations: [],
  });
  assert.equal(empty.artifact, null);
  assert.ok(empty.errors.some((entry) => entry.message === "The REST API doesn't contain any methods"));
});

test("S05: compile refuses missing integration, dangling authorizer, unsupported capability; returns warnings for unused models", () => {
  // Missing integration.
  const missing = compile({
    ...restDraft(),
    methods: [{ id: "m1", resourceId: "res1", httpMethod: "GET", integrationId: null }],
  });
  assert.equal(missing.artifact, null);
  assert.ok(missing.errors.some((entry) => entry.message === "No integration defined for method"));

  // Dangling authorizer.
  const dangling = compile({
    ...restDraft(),
    methods: [{ id: "m1", resourceId: "res1", httpMethod: "GET", integrationId: "int1", authorizerId: "auth-nope" }],
  });
  assert.equal(dangling.artifact, null);
  assert.ok(dangling.errors.some((entry) => entry.code === "unknown_authorizer"));

  // Unsupported capability: MOCK on HTTP.
  const unsupported = compile({
    projectId: "p", apiId: "a", apiPublicId: "x1y2z3w4v5", protocol: "HTTP",
    routes: [{ id: "r1", routeKey: "GET /pets", integrationId: "int1" }],
    integrations: [{ id: "int1", type: "MOCK" }],
  });
  assert.equal(unsupported.artifact, null);
  assert.ok(unsupported.errors.some((entry) => entry.code === "capability_unsupported"));

  // Warnings for unused models.
  const warned = compile({
    ...restDraft(),
    models: [{ name: "Unused", schema: { type: "object" } }],
  });
  assert.equal(warned.errors.length, 0);
  assert.ok(warned.warnings.some((entry) => entry.code === "unused_model"));
  // Unused integration warns but still deploys.
  const unusedInt = compile({
    ...restDraft(),
    integrations: [{ id: "int1", type: "MOCK" }, { id: "int2", type: "MOCK" }],
  });
  assert.equal(unusedInt.errors.length, 0);
  assert.ok(unusedInt.warnings.some((entry) => entry.code === "unused_integration"));
});

test("S05: artifact contains no secret values (fixture with backend_auth secret)", () => {
  setPlaintextCache(["super-secret-value-123"]);
  try {
    const draft = {
      projectId: "proj-1", apiId: "api-1", apiPublicId: "a1b2c3d4e5", protocol: "REST",
      resources: [{ id: "res1", path: "/pets" }],
      methods: [{ id: "m1", resourceId: "res1", httpMethod: "GET", integrationId: "int1" }],
      integrations: [{
        id: "int1", type: "HTTP_PROXY", uri: "https://backend.example.com/pets",
        backendAuth: { type: "bearer", secretRef: "secret:abc" },
      }],
    };
    // Sanity: a ref passes.
    const ok = compile(draft);
    assert.equal(ok.errors.length, 0);

    // A non-ref backend_auth value is refused.
    const badRef = compile({
      ...draft,
      integrations: [{
        id: "int1", type: "HTTP_PROXY", uri: "https://backend.example.com/pets",
        backendAuth: { type: "bearer", secretRef: "nope" },
      }],
    });
    assert.ok(badRef.errors.some((entry) => entry.code === "invalid_secret_ref"));

    // A plaintext value matching the vault cache throws (never stored).
    assert.throws(() => compile({
      ...draft,
      integrations: [{
        id: "int1", type: "HTTP_PROXY", uri: "https://backend.example.com/super-secret-value-123",
        backendAuth: { type: "bearer", secretRef: "secret:abc" },
      }],
    }), /must not contain secret values/);
  } finally {
    clearPlaintextCache();
  }
});

test("S05: stage variables substitute in integration URI and are validated (key/value charset, ≤100)", async () => {
  const { renderIntegrationUri } = await import("../../lib/gateway/core/integrations/uri.mjs");
  const rendered = renderIntegrationUri("https://backend.example.com/${stageVariables.ver}/pets", {
    pathParams: {}, greedyParams: [], stageVariables: { ver: "v1" },
  });
  assert.equal(rendered, "https://backend.example.com/v1/pets");

  const { errors: badKey } = validateStageVariables({ "bad-key!": "v1" });
  assert.equal(badKey.length, 1);
  const { errors: badValue } = validateStageVariables({ ok: "has space!" });
  assert.equal(badValue.length, 1);
  const many = {};
  for (let index = 0; index < 101; index += 1) many[`k${index}`] = "v";
  const { errors: tooMany } = validateStageVariables(many);
  assert.ok(tooMany.length >= 1);
  const { errors: none, clean } = validateStageVariables({ ver: "v1" });
  assert.equal(none.length, 0);
  assert.deepEqual(clean, { ver: "v1" });
});
