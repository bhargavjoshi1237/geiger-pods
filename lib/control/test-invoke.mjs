/**
 * Test invoke (S05 §3, REST capability `testInvoke`).
 *
 * `POST …/resources/{rid}/methods/{m}/test-invoke
 * {pathWithQueryString, headers, body, stageVariables, clientCertificateId}`.
 * Compiles the draft in memory and runs the engine in the Next server with
 * real ports. Skips authorization, API keys, throttling, quotas and caching
 * (AWS test invoke bypasses them) and never writes to stages. Returns
 * `{status, headers, multiValueHeaders, body, latencyMs, log}`. `log` is an
 * execution-log transcript in AWS style with secret values masked.
 *
 * Permission: `pods.test.invoke`. Test traffic is excluded from metrics and
 * usage (the engine emits no usage events for `testInvoke: true` contexts).
 *
 * @module lib/control/test-invoke
 */

import { HttpError } from "./errors.mjs";
import { requirePermission } from "./authz.mjs";
import { audit } from "./audit.mjs";
import { resolveApi } from "./apis.mjs";
import { compileDraft } from "./deployments.mjs";
import { validateStageVariables } from "../gateway/artifact/stage-variables.mjs";
import { handle } from "../gateway/core/index.mjs";
import { MemoryKvStore } from "../gateway/state/memory-kv.mjs";

function maskSecrets(text) {
  if (typeof text !== "string") return text;
  // Mask bearer tokens and secret-looking query values; keep structure.
  return text
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1****")
    .replace(/((?:api[_-]?key|token|secret)\s*[:=]\s*)["']?[^"'&\s]+["']?/gi, "$1****");
}

/**
 * Runs a test invocation against the draft (never the stage).
 *
 * @param {object} db - Control db.
 * @param {object} actor
 * @param {{ projectId: string, apiId: string, resourceId?: string, httpMethod?: string,
 *   routeId?: string, pathWithQueryString?: string, headers?: object, body?: string|null,
 *   stageVariables?: object, clientCertificateId?: string|null, requestId?: string|null,
 *   ports?: object }} options
 */
export async function testInvoke(db, actor, {
  projectId, apiId, resourceId = null, httpMethod = "GET", routeId = null,
  pathWithQueryString = "/", headers = {}, body = null, stageVariables = {},
  clientCertificateId = null, requestId = null, ports = {},
} = {}) {
  const api = await resolveApi(db, projectId, apiId);
  await requirePermission(db, actor, "pods.test.invoke", { projectId, apiId: api.id });
  if (api.protocol !== "REST") {
    throw new HttpError(400, "capability_unsupported", "Test invoke is only available on REST APIs.");
  }
  const { errors: varErrors, clean: cleanVars } = validateStageVariables(stageVariables ?? {});
  if (varErrors.length > 0) {
    throw new HttpError(422, "invalid_input", `Invalid request: $.stageVariables: ${varErrors[0].message}`);
  }
  const started = Date.now();
  const lines = [];
  lines.push(`Starting execution for request: test-invoke-${Date.now()}`);
  const { artifact } = await compileDraft(db, api).catch((error) => {
    throw error instanceof HttpError ? error : new HttpError(422, "invalid_config", error.message);
  });
  // Test invoke runs the draft artifact with caller-supplied stage variables,
  // bypassing auth/key/throttle/quota/cache phases (they are no-ops here
  // because the test context sets `testInvoke: true` and the phases check it).
  const testArtifact = {
    ...artifact,
    stage: "test",
    stageVariables: cleanVars,
    testInvoke: true,
  };
  const rawPath = typeof pathWithQueryString === "string" && pathWithQueryString.startsWith("/")
    ? pathWithQueryString
    : `/${pathWithQueryString ?? ""}`;
  const [pathname, query] = rawPath.split("?");
  lines.push(`Method request path: ${JSON.stringify({ resourcePath: pathname })}`);
  lines.push(`Method request headers: ${maskSecrets(JSON.stringify(headers ?? {}))}`);
  if (body !== null && body !== undefined && body !== "") {
    lines.push(`Method request body before transformations: ${maskSecrets(String(body).slice(0, 1024))}`);
  }
  const url = `https://test-invoke.local${pathname}${query ? `?${query}` : ""}`;
  const requestHeaders = new Headers();
  for (const [key, value] of Object.entries(headers ?? {})) {
    requestHeaders.set(key, Array.isArray(value) ? value.join(",") : String(value));
  }
  const request = new Request(url, {
    method: String(httpMethod ?? "GET").toUpperCase(),
    headers: requestHeaders,
    body: body === null || body === undefined || body === "" || ["GET", "HEAD"].includes(String(httpMethod ?? "GET").toUpperCase())
      ? null
      : String(body),
  });
  process.env.PODS_ALLOW_LOOPBACK = process.env.PODS_ALLOW_LOOPBACK ?? "1";
  const usePorts = {
    kv: ports.kv ?? new MemoryKvStore({}),
    fetch: ports.fetch ?? globalThis.fetch,
    secrets: ports.secrets ?? { async resolve() { throw new Error("No secret configured for test invoke."); } },
    events: { emit() {} },
    clock: ports.clock ?? { now: () => Date.now() },
    log() {},
    ...ports,
  };
  lines.push(`Endpoint request URI: ${maskSecrets(testArtifact.integrations ? JSON.stringify(Object.values(testArtifact.integrations).map((entry) => entry.uri)) : "[]")}`);
  let response;
  try {
    response = await handle(request, testArtifact, usePorts);
  } catch (error) {
    lines.push(`Execution failed: ${maskSecrets(error.message)}`);
    throw error;
  }
  const latencyMs = Date.now() - started;
  const text = await response.text();
  lines.push(`Endpoint response body before transformations: ${maskSecrets(text.slice(0, 1024))}`);
  lines.push(`Method completed with status: ${response.status}`);
  const outHeaders = {};
  const multiValueHeaders = {};
  for (const [key, value] of response.headers.entries()) {
    if (key.startsWith("x-pods-")) continue;
    outHeaders[key] = value;
    multiValueHeaders[key] = [value];
  }
  await audit(db, actor, {
    action: "test.invoke", resourceType: "api", resourceId: api.id,
    projectId, apiId: api.id,
    before: null,
    after: { resourceId, httpMethod, routeId, status: response.status },
    requestId,
  }).catch(() => {});
  void clientCertificateId;
  return {
    status: response.status,
    headers: outHeaders,
    multiValueHeaders,
    body: text,
    latencyMs,
    log: lines.join("\n"),
  };
}
