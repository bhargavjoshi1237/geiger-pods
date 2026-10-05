// Thin Next.js route-handler wrapper (S02 §4): JSON parsing with the 6 MB AWS
// import cap, actor resolution, permission checks, If-Match → version, error
// mapping and request-id headers. Handler logic lives in lib/control/** so it
// is unit-testable without Next. Route files stay thin.
//
// Next 16: `cookies()`/`headers()` are async, and route `params` is a Promise.

import { randomUUID } from "node:crypto";
import { resolveActor } from "./actor.mjs";
import { requirePermission } from "./authz.mjs";
import { HttpError } from "./errors.mjs";

/** AWS import payload cap reused for management API bodies. */
export const MAX_JSON_BYTES = 6 * 1024 * 1024;

export function newRequestId() {
  return randomUUID();
}

export function errorResponse(error, requestId) {
  const status = error instanceof HttpError ? error.status : 500;
  const body = { error: { code: "internal_error", message: "Internal server error" } };
  if (error instanceof HttpError) {
    body.error = { code: error.code, message: error.message };
    if (error.details !== undefined) body.error.details = error.details;
  }
  return Response.json(body, {
    status,
    headers: { "x-pods-request-id": requestId },
  });
}

export function jsonResponse(data, requestId, status = 200) {
  return Response.json(data ?? null, {
    status,
    headers: { "x-pods-request-id": requestId },
  });
}

async function readJsonBody(request) {
  if (request.method === "GET" || request.method === "HEAD") return null;
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > MAX_JSON_BYTES) {
    throw new HttpError(413, "body_too_large", "Request body exceeds the 6 MB limit.");
  }
  const text = await request.text();
  if (!text) return null;
  if (Buffer.byteLength(text, "utf8") > MAX_JSON_BYTES) {
    throw new HttpError(413, "body_too_large", "Request body exceeds the 6 MB limit.");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "invalid_json", "Request body must be valid JSON.");
  }
}

function parseIfMatch(request) {
  const raw = request.headers.get("if-match");
  if (raw === null) return null;
  const version = Number(raw.replace(/^W\//, "").replace(/^"|"$/g, ""));
  if (!Number.isInteger(version) || version < 0) {
    throw new HttpError(400, "invalid_input", "If-Match must be a non-negative integer version.");
  }
  return version;
}

/**
 * Wrap a management API handler.
 * @param {(ctx: { request: Request, params: object, projectId: string|null, db: object, actor: object, body: unknown, version: number|null, requestId: string, url: URL }) => Promise<unknown>} handler
 * @param {{ permission?: string|null, scopeBy?: string|null, needsService?: boolean, deps?: { createServerSupabase?: Function, createServiceSupabase?: Function, createControlDb?: Function } }} [options]
 * `needsService` attaches a service-role client for the server vault path
 * (secret version writes/envelope reads), after the permission check.
 */
export function route(handler, options = {}) {
  const { permission = null, scopeBy = null, needsService = false, deps = {} } = options;
  return async function routeHandler(request, routeContext = {}) {
    const requestId = newRequestId();
    try {
      const params = (await routeContext?.params) ?? {};
      const projectId = params.projectId ?? null;
      const body = await readJsonBody(request);
      const version = parseIfMatch(request);
      const createServerSupabase = deps.createServerSupabase
        ?? (await import("../supabase/server.js")).createServerSupabase;
      const supabase = await createServerSupabase();
      const createControlDb = deps.createControlDb
        ?? (await import("./supabase-db.mjs")).createControlDb;
      let service = null;
      if (needsService) {
        const createServiceSupabase = deps.createServiceSupabase
          ?? (await import("../supabase/server.js")).createServiceSupabase;
        service = createServiceSupabase();
      }
      const db = createControlDb(supabase, { service });
      // S14: Bearer access tokens resolve against the control DB (cookies
      // still work exactly as before when no Bearer value is present).
      const actor = await resolveActor(request, {
        supabase,
        controlDb: typeof db.getTokenByHash === "function" ? db : null,
        tokenIp: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      });
      // S14 §1: control-plane rate limit (10 rps sustained, burst 40).
      if (projectId) {
        const { sharedLimiter } = await import("./rate-limit.mjs");
        const verdict = sharedLimiter().consume(projectId);
        if (!verdict.allowed) {
          return Response.json({ error: { code: "rate_limited", message: "Control-plane rate limit exceeded." } }, {
            status: 429,
            headers: {
              "x-pods-request-id": requestId,
              "retry-after": String(Math.max(1, Math.ceil(verdict.retryAfterMs / 1000))),
            },
          });
        }
      }
      if (permission) {
        const apiId = scopeBy ? (params[scopeBy] ?? null) : (params.apiId ?? null);
        await requirePermission(db, actor, permission, { projectId, apiId });
      } else if (!actor) {
        throw new HttpError(401, "unauthenticated", "Sign in to continue.");
      }
      // S14 §1: Idempotency-Key on POST. Replays return the stored
      // response; the same key with a different body throws 422.
      const idempotencyKey = request.method === "POST" ? request.headers.get("idempotency-key")?.trim() || null : null;
      const actorKey = actor?.type === "token" ? `token:${actor.tokenId}` : actor?.type === "user" ? `user:${actor.userId}` : "anon";
      if (idempotencyKey && projectId && typeof db.getIdempotency === "function") {
        const { checkIdempotency, recordIdempotency } = await import("./rate-limit.mjs");
        const checked = await checkIdempotency(db, { projectId, actorKey, key: idempotencyKey, body });
        if (checked.replayed) {
          return jsonResponse(checked.body ?? null, requestId, checked.status ?? 200);
        }
        const result = await handler({
          request,
          params,
          projectId,
          db,
          actor,
          body,
          version,
          requestId,
          url: new URL(request.url),
        });
        await recordIdempotency(db, {
          projectId, actorKey, key: idempotencyKey, body,
          status: result !== null && typeof result === "object" && "status" in result ? result.status ?? 200 : 200,
          responseBody: result !== null && typeof result === "object" && "body" in result ? result.body : result,
        });
        if (result !== null && typeof result === "object" && ("body" in result || "status" in result)) {
          return jsonResponse(result.body ?? null, requestId, result.status ?? 200);
        }
        return jsonResponse(result, requestId, 200);
      }
      const result = await handler({
        request,
        params,
        projectId,
        db,
        actor,
        body,
        version,
        requestId,
        url: new URL(request.url),
      });
      if (result !== null && typeof result === "object" && ("body" in result || "status" in result)) {
        return jsonResponse(result.body ?? null, requestId, result.status ?? 200);
      }
      return jsonResponse(result, requestId, 200);
    } catch (error) {
      return errorResponse(error, requestId);
    }
  };
}
