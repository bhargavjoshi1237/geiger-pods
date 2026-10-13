/**
 * Supabase adapter for the S05 releases tables (production path):
 * `pods.deployments`, `pods.stages` and `pods.stage_history`.
 *
 * `createControlDb` (S02, shared) has no releases methods, so this module
 * attaches them the same way `usage-db.mjs` does: `withReleasesTables(db,
 * client, { service })` returns `db` plus the methods below. The in-memory
 * fake in `tests/s05/fake-db.mjs` is the behavioural contract; rows go in
 * and come out as snake_case DB rows.
 *
 * Reads and writes run as the caller through RLS (`client`). Notes on the
 * schema (supabase/migrations/releases + observability/distribution/portals
 * column additions) that this adapter respects:
 *
 * - Unknown keys are dropped before writing, so a stray camelCase key can
 *   never turn into a PostgREST "column does not exist" 400.
 * - `created_by` / `actor_id` default to `auth.uid()`; when the service passes
 *   `null` or a non-UUID actor id (API-key / system actors) the key is omitted
 *   so the default applies instead of failing the uuid cast.
 * - `stages.version` is not bumped by any trigger (`stages_touch_updated_at`
 *   only sets `updated_at`); the services put `version: current + 1` in the
 *   patch. Like `updateApi` in supabase-db.mjs, the adapter writes it as-is
 *   and does not add a DB-level version predicate (the services already do
 *   the `expectedVersion` check against the row they just read).
 * - The `stages_promote_guard` trigger (security definer) re-checks
 *   `pods.can('pods.stage.promote', …)` via `auth.uid()` whenever
 *   `deployment_id` changes, so stage updates must go through the caller's
 *   client, never the service role (auth.uid() is null there and the trigger
 *   would reject the move). Its `forbidden: …` exception maps to 403.
 * - `artifact` / `warnings` / stage settings are `jsonb`: plain objects are
 *   sent as-is (no bytea columns here).
 * - Stages and deployments have NO delete policy for `authenticated` — an
 *   RLS-scoped delete would silently match zero rows. `deleteStage` /
 *   `deleteDeployment` therefore require `options.service` (service role),
 *   are called only after the service checked `pods.stage.delete`, and first
 *   re-read the row through the caller's client so the service-role delete
 *   can only touch a row the caller can see. Without a service client they
 *   throw a 500 explaining the missing configuration.
 * - `stages.deployment_id` references deployments `on delete restrict`, so a
 *   racing delete of a still-referenced deployment surfaces as 409
 *   `deployment_in_use` (FK violation 23503).
 * - The cross-instance deploy lock (`pods.acquire_deploy_lock`) is already
 *   exposed as `advisoryLock` by supabase-db.mjs and is kept untouched.
 *
 * @module lib/control/releases-db
 */

import { HttpError } from "./errors.mjs";
import { decodeCursor, encodeCursor } from "./pagination.mjs";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DEPLOYMENT_COLUMNS = new Set([
  "id", "project_id", "api_id", "public_id", "description", "artifact", "digest",
  "schema_version", "warnings", "created_by", "created_at",
]);

/** Deployment list columns: everything except the (large) compiled artifact. */
const DEPLOYMENT_SUMMARY = "id, project_id, api_id, public_id, description, digest, schema_version, warnings, created_by, created_at";

const STAGE_COLUMNS = new Set([
  // S05 releases
  "id", "project_id", "api_id", "name", "deployment_id", "description", "variables",
  "auto_deploy", "client_certificate_id", "default_route_settings", "route_settings",
  "method_settings", "access_log", "tracing_enabled", "cache_cluster_enabled",
  "cache_cluster_size", "canary", "last_deployment_status_message", "tags",
  "created_by", "created_at", "updated_at", "version",
  // S09 release controls
  "cache_default_ttl", "cache_data_encrypted", "require_authorization_for_cache_control",
  "unauthorized_cache_control_header_strategy",
  // S07 distribution
  "documentation_version",
  // portals
  "agent_tools",
  // observability defaults
  "default_logging_level", "default_data_trace",
]);

/** Stage columns a patch may never change (identity + ownership). */
const STAGE_IMMUTABLE = new Set(["id", "project_id", "api_id", "created_by", "created_at", "updated_at"]);

const HISTORY_COLUMNS = new Set([
  "id", "project_id", "stage_id", "from_deployment_id", "to_deployment_id", "reason", "actor_id", "created_at",
]);

function pods(client) {
  return client.schema("pods");
}

function fail(message, status = 500, code = "internal_error", details) {
  throw new HttpError(status, code, message, details);
}

/**
 * Maps a PostgREST / Postgres error to an HttpError.
 *
 * @param {{ code?: string, message?: string }} error
 * @param {{ notFoundMessage?: string|null, conflictMessage?: string|null, fkMessage?: string|null }} [messages]
 * @returns {never}
 */
function raise(error, { notFoundMessage = null, conflictMessage = null, fkMessage = null } = {}) {
  const message = String(error?.message ?? "Database error.");
  if (error?.code === "PGRST116") fail(notFoundMessage ?? "Resource does not exist.", 404, "not_found");
  if (error?.code === "23505") fail(conflictMessage ?? "Duplicate value violates a uniqueness constraint.", 409, "conflict");
  if (error?.code === "23503" && fkMessage) fail(fkMessage, 409, "deployment_in_use");
  if (error?.code === "42501" || message.startsWith("forbidden")) {
    fail(message.startsWith("forbidden") ? message.replace(/^forbidden:\s*/, "") : "You do not have permission to perform this action.", 403, "forbidden");
  }
  fail(message);
}

async function one(query, messages = {}) {
  const { data, error } = await query;
  if (error) raise(error, messages);
  return data ?? null;
}

async function many(query) {
  const { data, error } = await query;
  if (error) raise(error);
  return data ?? [];
}

/** Keeps only known columns; omits actor uuid columns that are null/non-UUID. */
function pick(row, columns, { actorKeys = [], omit = null } = {}) {
  const out = {};
  for (const [key, value] of Object.entries(row ?? {})) {
    if (!columns.has(key) || value === undefined) continue;
    if (omit && omit.has(key)) continue;
    if (actorKeys.includes(key) && (typeof value !== "string" || !UUID_PATTERN.test(value))) continue;
    out[key] = value;
  }
  return out;
}

function isUuid(value) {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

/**
 * Attaches the S05 releases store to a control `db` object.
 *
 * @param {object} db - The request-scoped control db (permissions, audit, catalog…).
 * @param {object} client - A Supabase client for the caller (RLS applies).
 * @param {{ service?: object|null }} [options] - `service`: optional service-role
 *   client, used only for the stage/deployment deletes RLS has no policy for.
 * @returns {object} `db` plus the releases table methods.
 */
export function withReleasesTables(db, client, options = {}) {
  if (!client) return db;
  const store = pods(client);
  const service = options.service ?? null;

  /** Re-reads a row through RLS, then deletes it with the service role. */
  async function serviceDelete(table, id, { notFoundMessage, fkMessage = null }) {
    if (!isUuid(id)) fail(notFoundMessage, 404, "not_found");
    if (!service) {
      fail(`Deleting ${table} rows needs a service-role client (no delete RLS policy); configure SUPABASE_SERVICE_ROLE_KEY.`);
    }
    const visible = await one(store.from(table).select("id").eq("id", id).maybeSingle());
    if (!visible) fail(notFoundMessage, 404, "not_found");
    const rows = await one(pods(service).from(table).delete().eq("id", id).select("id"), { fkMessage });
    if (!rows || rows.length === 0) fail(notFoundMessage, 404, "not_found");
    return { id, deleted: true };
  }

  return {
    ...db,

    // --- deployments (immutable artifacts) ---

    /**
     * Newest-first page of deployments (artifact omitted). Returns a bare
     * array: the service asks for `limit + 1` rows and builds
     * `{ items, nextCursor }` itself, using the last row's id as the cursor.
     * `cursor` may be that deployment id, a `{ createdAt, id }` object, or an
     * encoded pagination cursor (lib/control/pagination.mjs).
     */
    async listDeployments({ apiId, limit = 25, cursor = null }) {
      const take = Math.min(Math.max(Number(limit) || 25, 1), 101);
      let query = store.from("deployments").select(DEPLOYMENT_SUMMARY).eq("api_id", apiId)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(take);
      if (cursor) {
        let after = null;
        if (typeof cursor === "object" && cursor.createdAt && isUuid(cursor.id)) {
          after = decodeCursor(encodeCursor(cursor));
        } else if (isUuid(cursor)) {
          const anchor = await one(store.from("deployments").select("id, created_at")
            .eq("api_id", apiId).eq("id", cursor).maybeSingle());
          if (!anchor) fail("Invalid pagination cursor.", 400, "invalid_input");
          after = { createdAt: anchor.created_at, id: anchor.id };
        } else {
          after = decodeCursor(cursor);
        }
        query = query.or(`created_at.lt.${after.createdAt},and(created_at.eq.${after.createdAt},id.lt.${after.id})`);
      }
      return many(query);
    },

    /** One deployment including its artifact, or null. */
    async getDeploymentById(id) {
      if (!isUuid(id)) return null;
      return one(store.from("deployments").select("*").eq("id", id).maybeSingle());
    },

    async insertDeployment(row) {
      return one(
        store.from("deployments").insert(pick(row, DEPLOYMENT_COLUMNS, { actorKeys: ["created_by"] })).select("*").single(),
        { conflictMessage: "A deployment with this id already exists." },
      );
    },

    /** Hard delete via the service role (no delete RLS policy; see module notes). */
    async deleteDeployment({ id }) {
      return serviceDelete("deployments", id, {
        notFoundMessage: "Deployment does not exist.",
        fkMessage: "Deployment is referenced by a stage.",
      });
    },

    // --- stages (mutable pointers + settings) ---

    async getStageByName({ apiId, name }) {
      if (typeof name !== "string" || name.length === 0 || !isUuid(apiId)) return null;
      return one(store.from("stages").select("*").eq("api_id", apiId).eq("name", name).maybeSingle());
    },

    async insertStage(row) {
      return one(
        store.from("stages").insert(pick(row, STAGE_COLUMNS, { actorKeys: ["created_by"] })).select("*").single(),
        { conflictMessage: `A stage named "${row?.name}" already exists.` },
      );
    },

    async listStages({ apiId }) {
      if (!isUuid(apiId)) return [];
      return many(store.from("stages").select("*").eq("api_id", apiId)
        .order("created_at", { ascending: true })
        .order("id", { ascending: true }));
    },

    /**
     * Applies `patch` (snake_case columns, including the caller's
     * `version: current + 1`). 404 when the row is missing or not writable
     * by the caller under RLS.
     */
    async updateStage({ id, patch }) {
      if (!isUuid(id)) fail("Stage does not exist.", 404, "not_found");
      const clean = pick(patch, STAGE_COLUMNS, { omit: STAGE_IMMUTABLE });
      if (Object.keys(clean).length === 0) {
        const current = await one(store.from("stages").select("*").eq("id", id).maybeSingle());
        if (!current) fail("Stage does not exist.", 404, "not_found");
        return current;
      }
      return one(store.from("stages").update(clean).eq("id", id).select("*").single(), {
        notFoundMessage: "Stage does not exist.",
        conflictMessage: "A stage with this name already exists.",
      });
    },

    /** Hard delete via the service role (no delete RLS policy); cascades history. */
    async deleteStage({ id }) {
      return serviceDelete("stages", id, { notFoundMessage: "Stage does not exist." });
    },

    // --- stage_history (append-only) ---

    async insertStageHistory(row) {
      return one(store.from("stage_history")
        .insert(pick(row, HISTORY_COLUMNS, { actorKeys: ["actor_id"] })).select("*").single());
    },

    /** Oldest-first pointer changes for a stage (matches the fake's insertion order). */
    async listStageHistory({ stageId, limit = null }) {
      if (!isUuid(stageId)) return [];
      let query = store.from("stage_history").select("*").eq("stage_id", stageId)
        .order("created_at", { ascending: true })
        .order("id", { ascending: true });
      if (limit !== null && limit !== undefined) query = query.limit(Math.min(Math.max(Number(limit) || 25, 1), 1000));
      return many(query);
    },
  };
}
