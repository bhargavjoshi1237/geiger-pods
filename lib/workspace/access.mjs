import rbacConfig from "../../geiger-rbac.config.js";

export function inheritedRole(project, memberships, userId) {
  if (!project || !userId) return null;
  if (!project.organizationId) return project.createdBy === userId ? "owner" : null;
  const membership = memberships.find((row) => row.organizationId === project.organizationId && row.userId === userId);
  if (!membership) return null;
  const role = String(membership.role ?? "").toLowerCase();
  return ["owner", "admin", "manager"].includes(role) ? role : "member";
}

export function inheritedAuthorization(roleKey, userId, projectId) {
  const role = rbacConfig.systemRoles.find((r) => r.key === roleKey);
  if (!role || !userId || !projectId) return { roles: [], grants: [] };
  const roleId = `${projectId}:inherited:${roleKey}`;
  return {
    roles: [{ ...role, id: roleId }],
    grants: [{ roleId, userId, projectId, scope: {}, status: "active" }],
  };
}
