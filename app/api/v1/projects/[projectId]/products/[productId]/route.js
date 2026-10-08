import { route } from "@/lib/control/http.mjs";
import { createControlDb } from "@/lib/control/supabase-db.mjs";
import { withPortalTables } from "@/lib/control/portal-db.mjs";
import { setProductSharing, updatePortalProduct } from "@/lib/control/portals.mjs";

export const runtime = "nodejs";

const deps = {
  createControlDb: (client, options) => withPortalTables(createControlDb(client, options), client),
};

export const PATCH = route(
  async ({ db, actor, projectId, params, body, requestId }) =>
    updatePortalProduct(db, actor, {
      projectId,
      productId: params.productId,
      patch: body ?? {},
      requestId,
    }),
  { permission: "pods.portal.write", deps },
);

export const PUT = route(
  async ({ db, actor, projectId, params, body, requestId }) =>
    setProductSharing(db, actor, {
      projectId,
      productId: params.productId,
      sharing: body?.sharing ?? { projects: [], organizations: [] },
      requestId,
    }),
  { permission: "pods.portal.write", deps },
);
