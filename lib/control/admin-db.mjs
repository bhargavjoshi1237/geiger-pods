/**
 * Supabase adapter for the S14 admin tables plus the small S10/S12 helpers
 * the shared control db never grew (production path).
 *
 * Groups: access tokens, event subscriptions/deliveries, declarative
 * stacks, generic resource tags, idempotency keys, sampling rules,
 * WebSocket route responses, and the log-sink helpers `getSinkById` /
 * `resolveSecretRef`. The test fakes (tests/s14, tests/s12, tests/s10) are
 * the behavioural contract; this file mirrors them over PostgREST.
 *
 * Reads/writes go through RLS as the caller (`client`). Two exceptions use
 * a privileged client (`options.service`, else a lazily created service
 * role client):
 *  - `getTokenByHash` / `recordTokenUse` run during actor resolution for
 *    `Authorization: Bearer` requests, which carry no cookie session, so RLS
 *    would hide the token row. The lookup key is the sha256 of a secret the
 *    caller presented, so it only ever reveals the caller's own token.
 *  - `resolveSecretRef` reads the vault envelope, which is unreadable to
 *    `authenticated` (column-level revoke); metadata reads stay on RLS.
 *
 * Compose it onto the control db (the lead wires it in supabase-db.mjs):
 *
 * ```js
 * import { withAdminTables } from "@/lib/control/admin-db.mjs";
 * const db = withAdminTables(createControlDb(client, opts), client, opts);
 * ```
 *
 * @module lib/control/admin-db
 */

import { HttpError } from "./errors.mjs";
import { newPublicId } from "../gateway/ids.mjs";
import { resolveSecretRef as vaultResolveSecretRef, VaultError } from "../vault/secrets.mjs";
import { VaultConfigError } from "../vault/keys.mjs";
import { IDEMPOTENCY_TTL_MS } from "./rate-limit.mjs";

/** Tag key that binds a resource to a declarative stack (see stacks.mjs). */
const STACK_TAG = "pods:stack";

/** Tag key prefixes reserved for the system (users cannot set them). */
const RESERVED_TAG_PREFIXES = ["pods:", "aws:"];

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Every access_tokens column except `token_hash` (never leaves the db layer). */
const TOKEN_COLUMNS = "id, project_id, kind, user_id, name, prefix, scopes, expires_at, last_used_at, last_used_ip, revoked_at, created_by, created_at, updated_at, version";

/** Columns a delivery update may touch (anything else is ignored). */
const DELIVERY_PATCH_FIELDS = ["status", "attempts", "next_attempt_at", "last_error"];

function pods(client) {
  return client.schema("pods");
}

function fail(message, status = 500, code = "internal_error") {
  throw new HttpError(status, code, message);
}

async function one(query, { notFoundMessage = null, conflictMessage = null } = {}) {
  const { data, error } = await query;
  if (error) {
    if (error.code === "PGRST116" && notFoundMessage) fail(notFoundMessage, 404, "not_found");
    if (error.code === "23505") fail(conflictMessage ?? "Duplicate value violates a uniqueness constraint.", 409, "conflict");
    fail(error.message);
  }
  return data;
}

async function many(query) {
  const { data, error } = await query;
  if (error) fail(error.message);
  return data ?? [];
}

async function run(query) {
  const { error } = await query;
  if (error) fail(error.message);
}

function isReservedTag(key) {
  const lower = String(key).toLowerCase();
  return RESERVED_TAG_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/** `bytea` columns of a secret_versions row come back as `\x…` hex. */
function envelopeFromDb(row) {
  if (!row) return row;
  const out = { ...row };
  for (const key of ["ciphertext", "iv", "auth_tag", "wrapped_dek"]) {
    if (typeof out[key] === "string" && out[key].startsWith("\\x")) {
      out[key] = Buffer.from(out[key].slice(2), "hex");
    }
  }
  return out;
}

/**
 * Picks the signing string out of a resolved vault value. Generic/header
 * secrets carry `value`; bearer `token`; basic auth `password`; OAuth
 * clients `clientSecret`.
 */
function signingString(resolved) {
  const value = resolved?.value;
  if (typeof value === "string") return value;
  for (const field of ["value", "token", "password", "clientSecret"]) {
    if (typeof value?.[field] === "string" && value[field] !== "") return value[field];
  }
  return null;
}

/** Live API row → the shape the stack `api` kind diffs (`settings` lives in metadata). */
function stackApiView(row) {
  return { ...row, settings: row.metadata?.stackSettings ?? {} };
}

/**
 * Attaches the admin-table store to a control `db` object.
 *
 * @param {object} db - The request-scoped control db (permissions, audit, catalog, vault).
 * @param {object} client - The caller's Supabase client (RLS applies).
 * @param {{ service?: object|null }} [options] - `service`: a service-role client, if the route has one.
 * @returns {object} `db` plus the admin methods.
 */
export function withAdminTables(db, client, options = {}) {
  if (!client) return db;
  const store = pods(client);
  let privileged = options.service ?? null;

  /** Service-role client for the RLS-exempt paths (created on first use). */
  async function privilegedStore() {
    if (!privileged) {
      const { createServiceSupabase } = await import("../supabase/server.js");
      privileged = createServiceSupabase();
    }
    return pods(privileged);
  }

  async function liveApiRow({ projectId, id }) {
    if (!id || !UUID_PATTERN.test(String(id))) return null;
    return one(store.from("apis").select("*").eq("project_id", projectId).eq("id", id)
      .is("deleted_at", null).maybeSingle());
  }

  async function untagStack({ projectId, resourceType, resourceId }) {
    await run(store.from("tags").delete().eq("project_id", projectId).eq("resource_type", resourceType)
      .eq("resource_id", String(resourceId)).eq("key", STACK_TAG));
  }

  return {
    ...db,

    // --- access tokens (S14 §2) ---------------------------------------------
    async getTokenByHash({ hash }) {
      if (typeof hash !== "string" || hash === "") return null;
      const service = await privilegedStore();
      return one(service.from("access_tokens").select(TOKEN_COLUMNS).eq("token_hash", hash).maybeSingle());
    },
    async recordTokenUse({ id, ip = null }) {
      const service = await privilegedStore();
      await run(service.from("access_tokens")
        .update({ last_used_at: new Date().toISOString(), last_used_ip: ip ?? null })
        .eq("id", id));
    },
    async listTokens({ projectId }) {
      return many(store.from("access_tokens").select(TOKEN_COLUMNS).eq("project_id", projectId)
        .order("created_at", { ascending: false }));
    },
    async insertToken(row) {
      return one(store.from("access_tokens").insert(row).select(TOKEN_COLUMNS).single(),
        { conflictMessage: "Token collision; retry." });
    },
    async getTokenById({ id }) {
      if (!UUID_PATTERN.test(String(id ?? ""))) return null;
      return one(store.from("access_tokens").select(TOKEN_COLUMNS).eq("id", id).maybeSingle());
    },
    async revokeToken({ id }) {
      // Already-revoked tokens keep their original revocation time.
      await run(store.from("access_tokens").update({ revoked_at: new Date().toISOString() })
        .eq("id", id).is("revoked_at", null));
      return { id, revoked: true };
    },

    // --- event subscriptions + deliveries (S14 §6) ---------------------------
    async listEventSubscriptions({ projectId }) {
      return many(store.from("event_subscriptions").select("*").eq("project_id", projectId)
        .order("created_at", { ascending: true }));
    },
    async insertEventSubscription(row) {
      return one(store.from("event_subscriptions").insert(row).select("*").single(),
        { conflictMessage: `An event subscription named "${row?.name}" already exists.` });
    },
    async getEventSubscription({ id }) {
      if (!UUID_PATTERN.test(String(id ?? ""))) return null;
      return one(store.from("event_subscriptions").select("*").eq("id", id).maybeSingle());
    },
    async deleteEventSubscription({ id }) {
      // Hard delete (no deleted_at column); deliveries cascade.
      await run(store.from("event_subscriptions").delete().eq("id", id));
      return { id, deleted: true };
    },
    async listEventSubscriptionsFor({ projectId, eventType }) {
      return many(store.from("event_subscriptions").select("*").eq("project_id", projectId)
        .contains("event_types", [eventType]));
    },
    async insertEventDelivery(row) {
      return one(store.from("event_deliveries").insert(row).select("*").single());
    },
    async updateEventDelivery({ id, ...patch }) {
      const clean = {};
      for (const field of DELIVERY_PATCH_FIELDS) if (patch[field] !== undefined) clean[field] = patch[field];
      return one(store.from("event_deliveries").update(clean).eq("id", id).select("*").single(),
        { notFoundMessage: "Event delivery does not exist." });
    },

    // --- declarative stacks (S14 §4) -------------------------------------------
    // Live state = resources tagged `pods:stack = <stack>`, keyed by the
    // handler kind (`api`, `portals`). Soft-deleted APIs drop out.
    async listStackResources({ projectId, stack }) {
      const tags = await many(store.from("tags").select("resource_type, resource_id")
        .eq("project_id", projectId).eq("key", STACK_TAG).eq("value", stack));
      const idsOf = (type) => [...new Set(tags.filter((row) => row.resource_type === type)
        .map((row) => row.resource_id).filter((id) => UUID_PATTERN.test(id)))];
      const apiIds = idsOf("api");
      const portalIds = idsOf("portal");
      const apis = apiIds.length === 0 ? [] : await many(store.from("apis").select("*")
        .eq("project_id", projectId).in("id", apiIds).is("deleted_at", null)
        .order("created_at", { ascending: true }));
      const portals = portalIds.length === 0 ? [] : await many(store.from("portals").select("*")
        .eq("project_id", projectId).in("id", portalIds).order("created_at", { ascending: true }));
      return { api: apis.map(stackApiView), portals };
    },
    async upsertStack(row) {
      const clean = { project_id: row.project_id, name: row.name };
      for (const field of ["status", "last_error", "last_applied_hash"]) {
        if (row[field] !== undefined) clean[field] = row[field];
      }
      if (row.status === "applied") clean.last_applied_at = new Date().toISOString();
      return one(store.from("stacks").upsert(clean, { onConflict: "project_id,name" }).select("*").single());
    },
    async getStack({ projectId, name }) {
      return one(store.from("stacks").select("*").eq("project_id", projectId).eq("name", name).maybeSingle());
    },
    async stackCreateApi({ project_id, name, file = {} }) {
      const protocol = file.protocol ?? "REST";
      const row = {
        project_id,
        public_id: newPublicId(),
        name,
        protocol,
        description: typeof file.description === "string" ? file.description : "",
        metadata: { stackSettings: file.settings ?? {} },
      };
      // Same protocol defaults as the createApi service.
      if (protocol === "WEBSOCKET") row.api_key_selection_expression = "$request.header.x-api-key";
      const created = await db.insertApi(row);
      if (protocol === "REST") {
        await db.insertResource({ project_id, api_id: created.id, parent_id: null, path_part: "", path: "/" });
      }
      return stackApiView(created);
    },
    async tagStackResource({ project_id, stack, resource_type, resource_id }) {
      if (typeof stack !== "string" || stack === "" || resource_id === undefined || resource_id === null) return null;
      return one(store.from("tags").upsert({
        project_id, resource_type, resource_id: String(resource_id), key: STACK_TAG, value: stack,
      }, { onConflict: "project_id,resource_type,resource_id,key" }).select("*").single());
    },
    async stackUpdateApi({ project_id, id, file = {} }) {
      const current = await liveApiRow({ projectId: project_id, id });
      if (!current) fail("API does not exist.", 404, "not_found");
      const patch = {};
      if (typeof file.description === "string") patch.description = file.description;
      if (file.settings !== undefined) patch.metadata = { ...(current.metadata ?? {}), stackSettings: file.settings ?? {} };
      if (Object.keys(patch).length === 0) return stackApiView(current);
      const updated = await db.updateApi({ id: current.id, patch: { ...patch, version: current.version + 1 } });
      return stackApiView(updated);
    },
    async stackDeleteApi({ project_id, id }) {
      const current = await liveApiRow({ projectId: project_id, id });
      if (!current) return { id: id ?? null, deleted: false };
      await db.softDeleteApi({ id: current.id, version: current.version + 1 });
      await untagStack({ projectId: project_id, resourceType: "api", resourceId: current.id }).catch(() => null);
      return { id: current.id, deleted: true };
    },

    // --- resource tags (S14 §5) --------------------------------------------------
    async listTags({ projectId, resourceType, resourceId }) {
      return many(store.from("tags").select("*").eq("project_id", projectId)
        .eq("resource_type", resourceType).eq("resource_id", String(resourceId))
        .order("key", { ascending: true }));
    },
    // Replaces the user tag set. Reserved `pods:`/`aws:` system tags (e.g.
    // stack membership) survive: users can never set them, so a user PUT or
    // DELETE must not silently detach a resource from its stack. Upsert
    // first, then delete leftovers by id, so a mid-way failure leaves a
    // superset rather than an empty set.
    async replaceTags({ project_id, resource_type, resource_id, tags = [] }) {
      const resourceId = String(resource_id);
      if (tags.length > 0) {
        await run(store.from("tags").upsert(
          tags.map(({ key, value }) => ({ project_id, resource_type, resource_id: resourceId, key, value: value ?? "" })),
          { onConflict: "project_id,resource_type,resource_id,key" },
        ));
      }
      const wanted = new Set(tags.map((entry) => entry.key));
      const existing = await many(store.from("tags").select("id, key").eq("project_id", project_id)
        .eq("resource_type", resource_type).eq("resource_id", resourceId));
      const stale = existing.filter((row) => !wanted.has(row.key) && !isReservedTag(row.key)).map((row) => row.id);
      if (stale.length > 0) await run(store.from("tags").delete().in("id", stale));
    },

    // --- idempotency keys (S14 §1) -------------------------------------------------
    async getIdempotency({ projectId, actorKey, key }) {
      return one(store.from("idempotency_keys").select("*").eq("project_id", projectId)
        .eq("actor_key", actorKey).eq("idempotency_key", key).maybeSingle());
    },
    // Upsert: checkIdempotency only lets a write through when the key is
    // absent or expired, so an expired row is replaced (fresh 24 h window).
    // `response_body` is NOT NULL jsonb; a null body is stored as `{}`.
    async insertIdempotency(row) {
      const now = Date.now();
      return one(store.from("idempotency_keys").upsert({
        project_id: row.project_id,
        actor_key: row.actor_key,
        idempotency_key: row.idempotency_key,
        request_hash: row.request_hash,
        response_status: row.response_status,
        response_body: row.response_body ?? {},
        created_at: new Date(now).toISOString(),
        expires_at: new Date(now + IDEMPOTENCY_TTL_MS).toISOString(),
      }, { onConflict: "project_id,actor_key,idempotency_key" }).select("*").single());
    },

    // --- sampling rules (S10 §5) ---------------------------------------------------
    async listSamplingRules({ projectId }) {
      return many(store.from("sampling_rules").select("*").eq("project_id", projectId)
        .order("priority", { ascending: true }).order("created_at", { ascending: true }));
    },
    async insertSamplingRule(row) {
      return one(store.from("sampling_rules").insert(row).select("*").single());
    },
    async deleteSamplingRule({ id }) {
      await run(store.from("sampling_rules").delete().eq("id", id));
      return { id, deleted: true };
    },

    // --- WebSocket route responses (S12 §1; soft delete) -----------------------
    async listRouteResponses({ routeId }) {
      return many(store.from("route_responses").select("*").eq("route_id", routeId)
        .is("deleted_at", null).order("created_at", { ascending: true }));
    },
    async getRouteResponseByKey({ routeId, key }) {
      return one(store.from("route_responses").select("*").eq("route_id", routeId)
        .eq("route_response_key", key).is("deleted_at", null).maybeSingle());
    },
    async getRouteResponseById({ id }) {
      if (!UUID_PATTERN.test(String(id ?? ""))) return null;
      return one(store.from("route_responses").select("*").eq("id", id).is("deleted_at", null).maybeSingle());
    },
    async insertRouteResponse(row) {
      return one(store.from("route_responses").insert(row).select("*").single(),
        { conflictMessage: `A route response with key "${row?.route_response_key}" already exists.` });
    },
    async deleteRouteResponse({ id }) {
      await run(store.from("route_responses").update({ deleted_at: new Date().toISOString() })
        .eq("id", id).is("deleted_at", null));
      return { id, deleted: true };
    },

    // --- log-sink helpers (S10 §4) -------------------------------------------------
    // Access-log destinations name a sink by id or by name. No project scope
    // is passed, so RLS bounds the lookup; an ambiguous name resolves to null.
    async getSinkById(idOrName) {
      if (typeof idOrName !== "string" || idOrName === "") return null;
      if (UUID_PATTERN.test(idOrName)) {
        return one(store.from("log_sinks").select("*").eq("id", idOrName).maybeSingle());
      }
      const rows = await many(store.from("log_sinks").select("*").eq("name", idOrName).limit(2));
      return rows.length === 1 ? rows[0] : null;
    },
    // Resolves a `secret:<id>[@version]` ref to the signing string. Metadata
    // reads go through RLS (the caller must see the secret); only the
    // envelope read uses the service role, like the vault resolve path.
    async resolveSecretRef(ref, { projectId = null } = {}) {
      const vaultDb = {
        ...db,
        async getSecretVersionEnvelope(secretId, version) {
          const service = await privilegedStore();
          return envelopeFromDb(await one(service.from("secret_versions").select("*")
            .eq("secret_id", secretId).eq("version", version).maybeSingle()));
        },
      };
      let resolved;
      try {
        resolved = await vaultResolveSecretRef(vaultDb, ref, projectId ? { projectId } : {});
      } catch (error) {
        if (error instanceof VaultConfigError) fail(`Vault is not configured: ${error.message}`, 500, "vault_unconfigured");
        if (error instanceof VaultError) {
          fail(error.message, error.code === "NOT_FOUND" ? 404 : 422, error.code === "NOT_FOUND" ? "not_found" : "invalid_input");
        }
        throw error;
      }
      const secret = signingString(resolved);
      if (secret === null) fail(`Secret kind "${resolved?.kind}" has no signing value.`, 422, "invalid_input");
      return secret;
    },
  };
}
