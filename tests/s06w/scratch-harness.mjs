/**
 * SCRATCH verification harness for S06W (deleted before finishing).
 * Hand-rolls the pipeline context (buildContext is currently unimportable
 * due to another agent's in-progress observe refactor) and drives the S06W
 * phases + real HTTP dispatch directly. Replicates pipeline semantics:
 * first Response wins, GatewayError → customized gateway response.
 */
import { GatewayError } from "../../lib/gateway/core/errors.mjs";
import { gatewayErrorResponse } from "../../lib/gateway/core/processing/runtime.mjs";
import { handlePreflight, isPreflightRequest } from "../../lib/gateway/core/processing/cors.mjs";
import { MemoryKvStore } from "../../lib/gateway/state/memory-kv.mjs";
import * as match from "../../lib/gateway/core/phases/match.mjs";
import * as cors from "../../lib/gateway/core/phases/cors.mjs";
import * as validate from "../../lib/gateway/core/phases/validate.mjs";
import * as integrationRequest from "../../lib/gateway/core/phases/integration-request.mjs";
import * as integrationResponse from "../../lib/gateway/core/phases/integration-response.mjs";
import * as methodResponse from "../../lib/gateway/core/phases/method-response.mjs";
import { invokeHttp } from "../../lib/gateway/core/integrations/http.mjs";
import { invokeMock } from "../../lib/gateway/core/integrations/mock.mjs";

process.env.PODS_ALLOW_LOOPBACK = "1";

let requestCounter = 0;

export function testPorts() {
  const clock = { now: () => Date.now() };
  return {
    fetch: globalThis.fetch,
    kv: new MemoryKvStore({ clock }),
    secrets: { async resolve() { throw new Error("no secrets in S06W tests"); } },
    events: { emit() {} },
    clock,
    log: () => {},
  };
}

/**
 * Minimal pipeline context (mirrors buildContext fields the S06W phases use).
 */
export function scratchContext(request, artifact) {
  const url = new URL(request.url);
  const requestId = `s06w-test-${++requestCounter}`;
  return {
    request,
    artifact,
    ports: testPorts(),
    requestId,
    startTime: Date.now(),
    signal: new AbortController().signal,
    context: {
      requestId,
      httpMethod: request.method,
      path: url.pathname,
      resourcePath: "",
      resourceId: "",
      routeKey: "",
      stage: artifact.stage ?? "$default",
      accountId: artifact.projectId ?? "",
      apiId: artifact.apiPublicId ?? "",
      identity: { sourceIp: "127.0.0.1", userAgent: "" },
      error: { message: "", messageString: '""', responseType: "", validationErrorString: "" },
    },
    stageVariables: { ...(artifact.stageVariables ?? {}) },
  };
}

/**
 * Runs a request through match → cors → validate → integrationRequest →
 * adapter → integrationResponse → methodResponse.
 *
 * @param {Request} request
 * @param {object} artifact
 * @param {string} [requestPath] - Stage-stripped path (what the server sets).
 * @returns {Promise<Response>}
 */
export async function runHarness(request, artifact, requestPath = null) {
  const ctx = scratchContext(request, artifact);
  const path = requestPath ?? new URL(request.url).pathname;
  ctx.requestPath = path;
  ctx.basePathStripped = path;

  if ((artifact.protocol ?? "REST") === "HTTP" && artifact.settings?.cors && isPreflightRequest(request)) {
    const answer = handlePreflight(request, artifact.settings.cors, { features: artifact.features ?? {} });
    if (answer) return answer;
  }

  const runOne = async (phase) => phase.run(ctx);
  try {
    for (const phase of [match, cors, validate, integrationRequest]) {
      const out = await runOne(phase);
      if (out instanceof Response) return out;
    }
    // invoke (S06 path only; the S05 fallback is S05-tested).
    if (ctx.integrationConfig && ctx.outbound) {
      const type = ctx.integrationConfig.type;
      if (type === "MOCK") {
        ctx.integrationResult = await invokeMock(ctx, ctx.integrationConfig, ctx.outbound);
      } else if (type === "HTTP_PROXY" || type === "HTTP") {
        try {
          ctx.integrationResult = await invokeHttp(ctx, ctx.integrationConfig, ctx.outbound, ctx.ports ?? {});
        } catch (error) {
          if (error?.type === "INTEGRATION_TIMEOUT" || error?.type === "INTEGRATION_FAILURE") {
            return errorResponse(ctx, error);
          }
          throw error;
        }
      } else {
        throw new Error(`scratch harness has no adapter for ${type}`);
      }
    }
    for (const phase of [integrationResponse, methodResponse]) {
      const out = await runOne(phase);
      if (out instanceof Response) return out;
    }
  } catch (err) {
    return errorResponse(ctx, err);
  }
  const protocol = artifact.protocol ?? "REST";
  return errorResponse(ctx, protocol === "HTTP"
    ? new GatewayError("RESOURCE_NOT_FOUND", "Not Found")
    : new GatewayError("MISSING_AUTHENTICATION_TOKEN", "Missing Authentication Token"));
}

/**
 * @param {object} ctx
 * @param {unknown} err
 * @returns {Promise<Response>}
 */
async function errorResponse(ctx, err) {
  const response = err instanceof GatewayError
    ? await gatewayErrorResponse(ctx, err)
    : await gatewayErrorResponse(ctx, new GatewayError("API_CONFIGURATION_ERROR", "Internal server error"));
  if (!response.headers.has("x-pods-request-id")) {
    response.headers.set("x-pods-request-id", ctx.requestId);
  }
  return response;
}
