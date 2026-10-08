import { route } from "@/lib/control/http.mjs";
import { createControlDb } from "@/lib/control/supabase-db.mjs";
import { withPortalTables } from "@/lib/control/portal-db.mjs";
import { createPortalProduct, listVisibleProducts } from "@/lib/control/portals.mjs";

export const runtime = "nodejs";

const deps = {
  createControlDb: (client, options) => withPortalTables(createControlDb(client, options), client),
};

export const GET = route(
  async ({ db, actor, projectId }) => ({ items: await listVisibleProducts(db, actor, { projectId }) }),
  { permission: "pods.apis.view", deps },
);

export const POST = route(
  async ({ db, actor, projectId, body, requestId }) =>
    createPortalProduct(db, actor, {
      projectId,
      name: body?.name,
      description: body?.description ?? "",
      displayOrder: body?.displayOrder ?? 0,
      usagePlanId: body?.usagePlanId ?? null,
      sharing: body?.sharing ?? null,
      requestId,
    }),
  { permission: "pods.portal.write", deps },
);
