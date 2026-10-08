import { route } from "@/lib/control/http.mjs";
import { createControlDb } from "@/lib/control/supabase-db.mjs";
import { withPortalTables } from "@/lib/control/portal-db.mjs";
import { linkProductToPortal } from "@/lib/control/portals.mjs";

export const runtime = "nodejs";

const deps = {
  createControlDb: (client, options) => withPortalTables(createControlDb(client, options), client),
};

export const GET = route(
  async ({ db, actor, projectId, params }) => {
    const { requirePermission } = await import("@/lib/control/authz.mjs");
    await requirePermission(db, actor, "pods.apis.view", { projectId });
    const links = typeof db.listPortalLinks === "function"
      ? await db.listPortalLinks({ portalId: params.portalId })
      : [];
    return { items: links };
  },
  { permission: "pods.apis.view", deps },
);

export const POST = route(
  async ({ db, actor, projectId, params, body }) =>
    linkProductToPortal(db, actor, {
      projectId,
      portalId: params.portalId,
      productId: body?.productId,
      order: body?.order ?? 0,
    }),
  { permission: "pods.portal.write", deps },
);
