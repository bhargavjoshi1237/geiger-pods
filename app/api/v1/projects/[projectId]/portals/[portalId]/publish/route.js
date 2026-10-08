import { route } from "@/lib/control/http.mjs";
import { createControlDb } from "@/lib/control/supabase-db.mjs";
import { withPortalTables } from "@/lib/control/portal-db.mjs";
import { publishPortal } from "@/lib/control/portals.mjs";

export const runtime = "nodejs";

const deps = {
  createControlDb: (client, options) => withPortalTables(createControlDb(client, options), client),
};

export const POST = route(
  async ({ db, actor, projectId, params, requestId }) =>
    publishPortal(db, actor, { projectId, portalId: params.portalId, requestId }),
  { permission: "pods.portal.publish", deps },
);
