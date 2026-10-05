/**
 * Pure draft builders for S06W tests (no engine imports, so compile-wiring
 * tests run even while other agents edit the engine phases).
 *
 * @module tests/s06w/helper
 */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { compile } from "../../lib/gateway/artifact/compile.mjs";

/**
 * Compiles a draft or throws with a readable message when errors are present.
 *
 * @param {object} draft
 * @returns {object} Compiled artifact (with `allowLoopback` test escape hatch).
 */
export function compileOrThrow(draft) {
  const { artifact, errors } = compile(draft);
  assert.equal(
    errors.length,
    0,
    `expected clean compile, got: ${JSON.stringify(errors)}`,
  );
  return { ...artifact, allowLoopback: true };
}

/**
 * Minimal REST draft (one resource + one method + one integration).
 *
 * @param {string} upstreamUrl
 * @param {object} [overrides={}] - Deep-ish overrides for method/integration/settings.
 * @returns {object} Draft ready for `compile`.
 */
export function restDraft(upstreamUrl, overrides = {}) {
  const method = {
    id: "m1",
    resourceId: "res-items",
    httpMethod: "GET",
    authorizationType: "NONE",
    integrationId: "int1",
    ...(overrides.method ?? {}),
  };
  const integration = {
    id: "int1",
    type: "HTTP_PROXY",
    uri: `${upstreamUrl}/echo`,
    timeoutMs: 5000,
    ...(overrides.integration ?? {}),
  };
  return {
    projectId: "proj-1",
    apiId: "api-rest",
    apiPublicId: overrides.apiPublicId ?? "s06wrest0001",
    protocol: "REST",
    resources: [
      { id: "res-root", path: "/" },
      ...(overrides.resources ?? [{ id: "res-items", path: "/items" }]),
    ],
    methods: [method],
    integrations: [integration],
    models: overrides.models ?? [],
    validators: overrides.validators ?? [],
    ...(overrides.extra ?? {}),
  };
}

/**
 * Minimal HTTP draft (one route + one integration).
 *
 * @param {string} upstreamUrl
 * @param {object} [overrides={}]
 * @returns {object} Draft ready for `compile`.
 */
export function httpDraft(upstreamUrl, overrides = {}) {
  const route = {
    id: "r1",
    routeKey: "GET /items",
    authorizationType: "NONE",
    integrationId: "int1",
    ...(overrides.route ?? {}),
  };
  const integration = {
    id: "int1",
    type: "HTTP_PROXY",
    uri: `${upstreamUrl}/echo`,
    timeoutMs: 5000,
    ...(overrides.integration ?? {}),
  };
  return {
    projectId: "proj-1",
    apiId: "api-http",
    apiPublicId: overrides.apiPublicId ?? "s06whttp0001",
    protocol: "HTTP",
    routes: [route],
    integrations: [integration],
    ...(overrides.extra ?? {}),
  };
}

/**
 * Random bytes (including invalid UTF-8) for binary round-trip tests.
 *
 * @param {number} n
 * @returns {Buffer}
 */
export function randomTestBytes(n) {
  return randomBytes(n);
}
