/**
 * Shared S09 test helpers: REST artifacts via `compile()` with MOCK or
 * HTTP_PROXY integrations, plus loopback + cache/canary wiring.
 *
 * @module tests/s09/helper
 */

import { compile } from "../../lib/gateway/artifact/compile.mjs";

process.env.PODS_ALLOW_LOOPBACK = "1";

/**
 * Compiles a REST draft with one GET /pets method.
 *
 * @param {object} [options={}]
 * @returns {{ artifact: object, ids: { methodId: string, integrationId: string } }}
 */
export function restArtifact({
  upstreamUrl = null,
  type = "MOCK",
  uri = null,
  methodOverrides = {},
  integrationOverrides = {},
  protocol = "REST",
  apiPublicId = "s09test0001",
} = {}) {
  const draft = {
    projectId: "proj-s09",
    apiId: "api-s09",
    apiPublicId,
    protocol,
    resources: [{ id: "res-root", path: "/" }, { id: "res-pets", path: "/pets" }],
    methods: [{
      id: "m-pets-get",
      resourceId: "res-pets",
      httpMethod: "GET",
      authorizationType: "NONE",
      authorizerId: null,
      authorizationScopes: [],
      apiKeyRequired: false,
      requestValidatorId: null,
      requestParameters: {},
      requestModels: {},
      integrationId: "int-1",
      ...methodOverrides,
    }],
    integrations: [{
      id: "int-1",
      type,
      uri: uri ?? (upstreamUrl ? `${upstreamUrl}/echo` : null),
      timeoutMs: 5000,
      ...integrationOverrides,
    }],
  };
  const { artifact, errors } = compile(draft);
  if (errors.length > 0) {
    throw new Error(`S09 fixture did not compile: ${errors[0].message}`);
  }
  return { artifact: { ...artifact, allowLoopback: true }, ids: { methodId: "m-pets-get", integrationId: "int-1" } };
}

/**
 * Mulberry32 seeded RNG (deterministic traffic splits in tests).
 *
 * @param {number} seed
 * @returns {() => number}
 */
export function seededRng(seed = 12345) {
  let state = seed >>> 0;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}
