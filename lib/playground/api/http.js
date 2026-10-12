// Shared plumbing for the playground's fake /api/v1 routes: the same envelope
// conventions as lib/control/http.mjs (`{ items, nextCursor }` lists,
// `{ error: { code, message } }` failures, 201 on create, If-Match versions),
// served from the in-memory seed. Rows stay raw snake_case DB rows; each
// domain module maps them with a copy of its lib/control view function.

import { json } from "../intercept_fetch.js";
import { getPlaygroundDb, PLAYGROUND_USER } from "../db.js";
import { PROJECT_ID } from "../seed/helpers.js";

export { json, PROJECT_ID };

export class PlaygroundHttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function fail(status, code, message) {
  throw new PlaygroundHttpError(status, code, message);
}

export const notFound = (what) => fail(404, "not_found", `${what} does not exist.`);

/** The table's rows (live array: push/splice/assign mutate the session's db). */
export function table(name) {
  return getPlaygroundDb().table(name);
}

export function nowIso() {
  return new Date().toISOString();
}

export function newId() {
  return globalThis.crypto.randomUUID();
}

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** 10-char `[a-z0-9]` public id, like lib/gateway/ids.mjs newPublicId(). */
export function newPublicId(length = 10) {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (byte) => ALPHABET[byte % ALPHABET.length]).join("");
}

export const ACTOR_ID = PLAYGROUND_USER.id;

/**
 * `{ items, nextCursor }` page with lib/control/pagination.mjs limits
 * (`?limit=` default 25, max 100). The cursor is an opaque offset here.
 */
export function page(items, query = {}, { defaultLimit = 25, maxLimit = 100 } = {}) {
  const take = Math.min(Math.max(Number(query.limit) || defaultLimit, 1), maxLimit);
  const offset = Math.max(Number.parseInt(query.cursor ?? "0", 10) || 0, 0);
  const slice = items.slice(offset, offset + take);
  return { items: slice, nextCursor: offset + take < items.length ? String(offset + take) : null };
}

export function created(body) {
  return json(body, 201);
}

export function byNewest(a, b) {
  return String(b.created_at).localeCompare(String(a.created_at));
}

export function byOldest(a, b) {
  return String(a.created_at).localeCompare(String(b.created_at));
}

/** Live (non-deleted) rows of a table matching `where`. */
export function live(name, where = () => true) {
  return table(name).filter((row) => row.deleted_at == null && where(row));
}

/** Expected version from an If-Match header (null when absent). */
export function ifMatch(request) {
  const raw = request?.headers?.get("if-match");
  if (raw == null) return null;
  const version = Number(String(raw).replace(/^W\//, "").replace(/^"|"$/g, ""));
  return Number.isInteger(version) ? version : null;
}

/** Optimistic-concurrency check matching lib/control's 409 `version_conflict`. */
export function checkVersion(row, request) {
  const expected = ifMatch(request);
  if (expected !== null && row.version != null && expected !== row.version) {
    fail(409, "version_conflict", `Changed since you loaded it (expected version ${expected}, found ${row.version}).`);
  }
}

/** Applies a snake_case patch in place, bumping version/updated_at. */
export function update(row, patch) {
  Object.assign(row, patch);
  if ("version" in row) row.version = (row.version ?? 1) + 1;
  if ("updated_at" in row) row.updated_at = nowIso();
  return row;
}

/** Inserts a row with the standard columns the real tables default. */
export function insert(name, row) {
  const now = nowIso();
  const full = { id: newId(), created_at: now, ...row };
  table(name).push(full);
  return full;
}

/** Soft delete when the table has `deleted_at`, hard delete otherwise. */
export function remove(name, row) {
  if ("deleted_at" in row) {
    row.deleted_at = nowIso();
    return;
  }
  const rows = table(name);
  const index = rows.indexOf(row);
  if (index >= 0) rows.splice(index, 1);
}

/** Appends an audit event, as lib/control/audit.mjs audit() does. */
export function audit({ action, resourceType, resourceId = null, apiId = null, before = null, after = null }) {
  table("audit_events").push({
    id: newId(),
    project_id: PROJECT_ID,
    actor_id: ACTOR_ID,
    actor_type: "user",
    action,
    resource_type: resourceType,
    resource_id: resourceId == null ? null : String(resourceId),
    api_id: apiId,
    before,
    after,
    request_id: newId(),
    source_ip: "203.0.113.24",
    user_agent: "Mozilla/5.0 (Pods playground)",
    created_at: nowIso(),
  });
}

/** Resolves an API by uuid or public id (404 otherwise), like resolveApi(). */
export function resolveApi(ref) {
  const row = table("apis").find((api) => api.deleted_at == null && (api.id === ref || api.public_id === ref));
  if (!row || row.project_id !== PROJECT_ID) notFound("API");
  return row;
}

function toError(error) {
  if (error instanceof PlaygroundHttpError) {
    return json({ error: { code: error.code, message: error.message } }, error.status);
  }
  throw error;
}

/**
 * Builds interceptFetch route entries under `/api/v1/projects/:projectId`,
 * mapping thrown PlaygroundHttpErrors to the API's error envelope.
 *
 *   routes([["GET", "/apis", ({ query }) => …]])
 */
export function routes(entries) {
  return entries.map(([method, path, handler]) => [
    method,
    `/api/v1/projects/:projectId${path}`,
    async (ctx) => {
      try {
        if (ctx.params.projectId !== PROJECT_ID) notFound("Project");
        return await handler(ctx);
      } catch (error) {
        return toError(error);
      }
    },
  ]);
}

/** Request body as an object (handlers read JSON bodies; null → {}). */
export function bodyOf(ctx) {
  return ctx.body && typeof ctx.body === "object" ? ctx.body : {};
}
