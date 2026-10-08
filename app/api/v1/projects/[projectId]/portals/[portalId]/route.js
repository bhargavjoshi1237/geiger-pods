import { route } from "@/lib/control/http.mjs";
import { createControlDb } from "@/lib/control/supabase-db.mjs";
import { withPortalTables } from "@/lib/control/portal-db.mjs";
import { updatePortal } from "@/lib/control/portals.mjs";

export const runtime = "nodejs";

const deps = {
  createControlDb: (client, options) => withPortalTables(createControlDb(client, options), client),
};

export const GET = route(
  async ({ db, actor, projectId, params }) => {
    const { requirePermission } = await import("@/lib/control/authz.mjs");
    await requirePermission(db, actor, "pods.apis.view", { projectId });
    const row = await db.getPortalById({ id: params.portalId });
    if (!row || row.project_id !== projectId) {
      const { HttpError } = await import("@/lib/control/errors.mjs");
      throw new HttpError(404, "not_found", "Portal does not exist.");
    }
    return { id: row.id, name: row.name, slug: row.slug, status: row.status, branding: row.branding, access: row.access };
  },
  { permission: "pods.apis.view", deps },
);

export const PATCH = route(
  async ({ db, actor, projectId, params, body, version, requestId }) =>
    updatePortal(db, actor, {
      projectId,
      portalId: params.portalId,
      patch: body ?? {},
      expectedVersion: version,
      requestId,
    }),
  { permission: "pods.portal.write", deps },
);
