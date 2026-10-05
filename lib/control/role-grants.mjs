// Product role grants service (S02 §3 + Management API table). Listing and
// writing grants needs pods.role.grant; granting additionally requires the
// grantor to hold every key on the role (mirrors pods.grant_role() in SQL).

import { can, expandPatterns, permissionKeys } from "@geiger/rbac";
import rbacConfig from "../../geiger-rbac.config.js";
import { v, validate } from "./validate.mjs";
import { HttpError } from "./errors.mjs";
import { loadBinding, requirePermission } from "./authz.mjs";
import { audit } from "./audit.mjs";

const GRANT_SCHEMA = v.object({
  userId: v.string({ min: 1, max: 128 }),
  roleKey: v.string({ min: 1, max: 128, pattern: "^[a-z][a-z0-9_]*$" }),
});

function cleanScope(scope) {
  if (scope === undefined) return {};
  if (typeof scope !== "object" || scope === null || Array.isArray(scope)) {
    throw new HttpError(422, "invalid_input", "Invalid request: $.scope: expected an object");
  }
  const out = {};
  for (const [key, value] of Object.entries(scope)) {
    if (!/^[a-z][a-z0-9_]*$/.test(key) || !Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
      throw new HttpError(422, "invalid_input", `Invalid request: $.scope.${key}: expected an array of string ids`);
    }
    out[key] = [...value];
  }
  return out;
}

/**
 * Refuse to grant a role holding keys the grantor lacks. Scope-restricted
 * holdings never authorize granting: without an unscoped holding (or an
 * inherited system role) the grantor cannot prove the wider reach.
 */
export function assertCanGrant(binding, targetRole) {
  const grantable = expandPatterns(targetRole.permissions, permissionKeys(binding.config));
  const missing = grantable.filter((key) => !can(key, binding));
  if (missing.length > 0) {
    throw new HttpError(403, "forbidden", `Cannot grant role "${targetRole.key}": grantor lacks ${missing.join(", ")}.`, { missing });
  }
  return grantable;
}

export async function listRoleGrants(db, actor, { projectId }) {
  await requirePermission(db, actor, "pods.role.grant", { projectId });
  const grants = await db.listRoleGrants({ projectId });
  return { items: grants, nextCursor: null };
}

export async function createRoleGrant(db, actor, { projectId, userId, roleKey, scope = {}, requestId = null }) {
  await requirePermission(db, actor, "pods.role.grant", { projectId });
  const clean = validate(GRANT_SCHEMA, { userId, roleKey });
  const grantScope = cleanScope(scope);
  const role = await db.getRoleByKey({ projectId, roleKey: clean.roleKey });
  if (!role) throw new HttpError(404, "not_found", `Role "${clean.roleKey}" does not exist in this project.`);
  const binding = await loadBinding(db, actor.userId, projectId);
  assertCanGrant({ ...binding, config: rbacConfig }, role);
  let grant;
  try {
    grant = await db.grantRole({ projectId, userId: clean.userId, roleKey: clean.roleKey, scope: grantScope });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(403, "forbidden", error?.message ?? "Grant refused by the database.");
  }
  await audit(db, actor, {
    action: "role.grant", resourceType: "role_grant", resourceId: grant.id ?? null,
    projectId, before: null, after: { userId: clean.userId, roleKey: clean.roleKey, scope: grantScope }, requestId,
  });
  return { status: 201, body: grant };
}

export async function revokeRoleGrant(db, actor, { projectId, grantId, requestId = null }) {
  await requirePermission(db, actor, "pods.role.grant", { projectId });
  const before = await db.getRoleGrantById({ projectId, grantId });
  let revoked;
  try {
    revoked = await db.revokeGrant({ projectId, grantId });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(404, "not_found", error?.message ?? "Grant does not exist.");
  }
  await audit(db, actor, {
    action: "role.revoke", resourceType: "role_grant", resourceId: grantId,
    projectId, before: before ?? null, after: null, requestId,
  });
  return revoked ?? { id: grantId, revoked: true };
}
