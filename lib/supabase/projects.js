import { inheritedRole } from "../workspace/access.mjs";

export async function listAccessibleProjects(client, userId) {
  if (!client || !userId) return [];
  const shared = client.schema("public");
  const [projectsResult, membershipsResult] = await Promise.all([
    shared.from("projects")
      .select("id, name, slug, organization_id, created_by, status, created_at")
      .is("deleted_at", null).order("created_at", { ascending: true }),
    shared.from("organization_users").select("organization, user, role").eq("user", userId),
  ]);
  if (projectsResult.error) throw new Error(projectsResult.error.message);
  if (membershipsResult.error) throw new Error(membershipsResult.error.message);
  const memberships = (membershipsResult.data || []).map((row) => ({
    organizationId: row.organization, userId: row.user, role: row.role,
  }));
  return (projectsResult.data || []).flatMap((row) => {
    const project = {
      id: row.id, name: row.name || "Untitled project", slug: row.slug || "",
      organizationId: row.organization_id ?? null, createdBy: row.created_by ?? null,
      status: row.status || "active", createdAt: row.created_at ?? null,
    };
    const role = inheritedRole(project, memberships, userId);
    return role ? [{ ...project, inheritedRole: role }] : [];
  });
}
