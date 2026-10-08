import { route } from "@/lib/control/http.mjs";
import { createControlDb } from "@/lib/control/supabase-db.mjs";
import { withPortalTables } from "@/lib/control/portal-db.mjs";
import { createPortal } from "@/lib/control/portals.mjs";

export const runtime = "nodejs";

const deps = {
  createControlDb: (client, options) => withPortalTables(createControlDb(client, options), client),
};

async function listPortals({ db, actor, projectId }) {
  const { requirePermission } = await import("@/lib/control/authz.mjs");
  await requirePermission(db, actor, "pods.apis.view", { projectId });
  const rows = typeof db.listPortals === "function" ? await db.listPortals({ projectId }) : [];
  return { items: rows.map((row) => ({ id: row.id, name: row.name, slug: row.slug, status: row.status })) };
}

export const GET = route(
  async ({ db, actor, projectId }) => listPortals({ db, actor, projectId }),
  { permission: "pods.apis.view", deps },
);

export const POST = route(
  async ({ db, actor, projectId, body, requestId }) =>
    createPortal(db, actor, {
      projectId,
      name: body?.name,
      slug: body?.slug,
      branding: body?.branding,
      access: body?.access,
      domainId: body?.domainId ?? null,
      analyticsEnabled: body?.analyticsEnabled ?? false,
      requestId,
    }),
  { permission: "pods.portal.write", deps },
);
