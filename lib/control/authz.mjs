// Server-side permission checks (S02 §4). Defense in depth: this evaluates the
// same catalog RLS enforces in Postgres. Pure inputs, injectable database.
//
// The `db` port the services need (implemented for Supabase in
// lib/control/supabase-db.mjs, faked in tests):
//   getInheritedRole({ projectId, userId }) → "owner"|"admin"|"manager"|"member"|null
//   listRoleBindings({ projectId, userId }) → { roles: Role[], grants: Grant[] }
// where Role/Grant rows match the @geiger/rbac { config, roles, grants } shape.

import { evaluate } from "@geiger/rbac";
import rbacConfig from "../../geiger-rbac.config.js";
import { inheritedAuthorization } from "../workspace/access.mjs";
import { HttpError } from "./errors.mjs";

/**
 * Tests whether any of the token's scope patterns covers `key`.
 * (The matcher lives in access-tokens.mjs; this import is deferred to
 * keep the S02 auth core free of S14 weight at module load.)
 */
async function tokenScopeCovers(scopes, key) {
  const { matchesScope } = await import("./access-tokens.mjs");
  return (scopes ?? []).some((pattern) => matchesScope(pattern, key));
}

/**
 * Require a permission key for an actor in a project, optionally scoped to an API.
 * @throws {HttpError} 401 when unauthenticated, 403 with the engine reason otherwise.
 *
 * Token actors (S14) intersect their scopes with the holder: a service
 * token (no user) passes on scope match alone (scopes were bounded at
 * creation); a personal token must also pass the normal user check, so
 * removing the user disables the token immediately.
 */
export async function requirePermission(db, actor, key, options = {}) {
  const { projectId = null, apiId = null } = options;
  if (!actor || (actor.type !== "user" && actor.type !== "token")) {
    throw new HttpError(401, "unauthenticated", "Sign in to continue.");
  }
  if (!projectId) {
    throw new HttpError(400, "invalid_input", "A project scope is required.");
  }
  if (actor.type === "token") {
    if (actor.projectId && actor.projectId !== projectId) {
      throw new HttpError(403, "forbidden", "This token belongs to a different project.", { permission: key });
    }
    if (!(await tokenScopeCovers(actor.scopes, key))) {
      throw new HttpError(403, "forbidden", "This token does not carry the required scope.", { permission: key });
    }
    if (!actor.userId) return { allowed: true, via: "service_token" };
    // Personal token: fall through to the user check (intersection).
  }
  if (actor.type === "token" && !actor.userId) {
    throw new HttpError(401, "invalid_token", "This token cannot be resolved to a project member.");
  }
  const userId = actor.userId;
  const roleKey = await db.getInheritedRole({ projectId, userId });
  const inherited = inheritedAuthorization(roleKey, userId, projectId);
  const extra = (await db.listRoleBindings({ projectId, userId })) ?? { roles: [], grants: [] };
  const decision = evaluate(key, {
    config: rbacConfig,
    roles: [...inherited.roles, ...(extra.roles ?? [])],
    grants: [...inherited.grants, ...(extra.grants ?? [])],
    actorId: userId,
    scopeId: apiId ?? undefined,
  });
  if (!decision.allowed) {
    throw new HttpError(403, "forbidden", decision.reason, { permission: key });
  }
  return decision;
}

/**
 * Load the full @geiger/rbac binding (for grant checks and UI gating).
 */
export async function loadBinding(db, userId, projectId) {
  const roleKey = await db.getInheritedRole({ projectId, userId });
  const inherited = inheritedAuthorization(roleKey, userId, projectId);
  const extra = (await db.listRoleBindings({ projectId, userId })) ?? { roles: [], grants: [] };
  return {
    config: rbacConfig,
    roles: [...inherited.roles, ...(extra.roles ?? [])],
    grants: [...inherited.grants, ...(extra.grants ?? [])],
    actorId: userId,
  };
}
