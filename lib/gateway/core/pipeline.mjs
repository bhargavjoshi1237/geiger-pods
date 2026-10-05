/**
 * Ordered phase runner. Each phase is `async (ctx) => void | Response`.
 * Returning a `Response`, or throwing `GatewayError`, short-circuits to
 * the response. The `emit` phase always runs last (post-response, never
 * blocks) so observability sees both successes and short-circuits.
 *
 * Every response leaves here carrying `x-pods-request-id`.
 *
 * @module lib/gateway/core/pipeline
 */

import { GatewayError } from "./errors.mjs";
import { renderGatewayError } from "./gateway-responses.mjs";
import { PHASES } from "./phases/index.mjs";
import { handlePreflight, isPreflightRequest } from "./processing/cors.mjs";
import { gatewayErrorResponse } from "./processing/runtime.mjs";

/**
 * Converts any thrown value into a gateway `Response`.
 *
 * S06W: gateway errors render through `gatewayErrorResponse`, which honors
 * gateway-response customization (`artifact.gatewayResponses` with
 * `DEFAULT_4XX`/`DEFAULT_5XX` fallback), records `$context.error.*` and
 * applies managed HTTP CORS headers. Artifacts without customizations
 * render byte-identical output to `renderGatewayError`.
 *
 * @param {unknown} err
 * @param {object} ctx - Pipeline context.
 * @returns {Promise<Response>}
 */
async function toGatewayResponse(err, ctx) {
  if (err instanceof GatewayError) {
    try {
      return await gatewayErrorResponse(ctx, err);
    } catch {
      return renderGatewayError(err, ctx);
    }
  }
  try {
    ctx?.ports?.log?.("gateway pipeline error", err);
  } catch {
    // Logging must never break the response path.
  }
  try {
    return await gatewayErrorResponse(
      ctx,
      new GatewayError("API_CONFIGURATION_ERROR", "Internal server error"),
    );
  } catch {
    return renderGatewayError(
      { type: "API_CONFIGURATION_ERROR", message: "Internal server error" },
      ctx,
    );
  }
}

/**
 * Ensures the response carries `x-pods-request-id` (set if missing).
 *
 * @param {Response} response
 * @param {object} ctx
 * @returns {Response}
 */
function withRequestId(response, ctx) {
  if (response.headers.has("x-pods-request-id")) return response;
  const id = ctx?.requestId ?? ctx?.context?.requestId ?? "";
  try {
    response.headers.set("x-pods-request-id", id);
    return response;
  } catch {
    // Responses from fetch() have immutable headers; re-wrap with mutable ones.
    const copy = new Response(response.body, response);
    copy.headers.set("x-pods-request-id", id);
    return copy;
  }
}

/**
 * Runs `phases` in order against `ctx`.
 * The first `Response` (or `GatewayError`) wins; `emit` still runs last
 * with `ctx.response` set, and its return value and errors are ignored.
 *
 * @param {object} ctx - Pipeline context (`request`, `artifact`, `ports`, ...).
 * @param {Array<{ name: string, run: (ctx: object) => Promise<Response | void> }>} [phases=PHASES]
 * @returns {Promise<Response | null>} The short-circuit response, or `null` when no phase responded.
 */
export async function runPhases(ctx, phases = PHASES) {
  const emit = phases.find((phase) => phase.name === "emit");
  const rest = emit ? phases.filter((phase) => phase !== emit) : phases;
  let response = null;
  try {
    for (const phase of rest) {
      const out = await phase.run(ctx);
      if (out instanceof Response) {
        response = out;
        break;
      }
    }
  } catch (err) {
    response = await toGatewayResponse(err, ctx);
  }
  if (response) {
    response = withRequestId(response, ctx);
    ctx.response = response;
  } else {
    ctx.response = null;
  }
  if (emit) {
    try {
      await emit.run(ctx);
    } catch (err) {
      try {
        ctx?.ports?.log?.("gateway emit error", err);
      } catch {
        // Emit must never block or break the response.
      }
    }
  }
  return response;
}

/**
 * Runs the registered {@link PHASES} pipeline. When no phase responds,
 * the S01 stub fallback applies (S03's `match` phase replaces it):
 * REST artifacts get `MISSING_AUTHENTICATION_TOKEN`, HTTP artifacts get
 * `RESOURCE_NOT_FOUND` — mirroring AWS for unknown routes.
 *
 * S06W: managed HTTP preflights are answered here, before `match` (row 5),
 * so no OPTIONS route is needed (spec §2). The `cors` phase answers
 * preflights that survive matching; both paths return the same 204.
 *
 * @param {object} ctx - Pipeline context.
 * @returns {Promise<Response>} Always a `Response`.
 */
export async function runPipeline(ctx) {
  const early = answerPreflight(ctx);
  if (early) {
    ctx.response = withRequestId(early, ctx);
    await runEmit(ctx);
    return ctx.response;
  }
  const response = await runPhases(ctx, PHASES);
  if (response) return response;
  const protocol = ctx?.artifact?.protocol ?? "REST";
  const fallback =
    protocol === "HTTP"
      ? new GatewayError("RESOURCE_NOT_FOUND", "Not Found")
      : new GatewayError("MISSING_AUTHENTICATION_TOKEN", "Missing Authentication Token");
  const rendered = await toGatewayResponse(fallback, ctx);
  ctx.response = withRequestId(rendered, ctx);
  return ctx.response;
}

/**
 * Answers a managed HTTP CORS preflight directly (S06 §2), or returns
 * `null` when this request is not a preflight.
 *
 * @param {object} ctx - Pipeline context.
 * @returns {Response|null}
 */
function answerPreflight(ctx) {
  try {
    const artifact = ctx?.artifact ?? {};
    if ((artifact.protocol ?? "REST") !== "HTTP") return null;
    const cors = artifact.settings?.cors ?? null;
    if (!cors || !ctx?.request || !isPreflightRequest(ctx.request)) return null;
    const answer = handlePreflight(ctx.request, cors, { features: artifact.features ?? {} });
    if (answer) ctx.corsPreflight = true;
    return answer;
  } catch {
    return null;
  }
}

/**
 * Runs the `emit` phase post-response (never blocks, never throws).
 *
 * @param {object} ctx - Pipeline context.
 */
async function runEmit(ctx) {
  const emit = PHASES.find((phase) => phase.name === "emit");
  if (!emit) return;
  try {
    await emit.run(ctx);
  } catch (err) {
    try {
      ctx?.ports?.log?.("gateway emit error", err);
    } catch {
      // Emit must never block or break the response.
    }
  }
}
