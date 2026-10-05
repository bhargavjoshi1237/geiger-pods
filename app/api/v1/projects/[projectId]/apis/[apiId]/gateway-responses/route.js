import { route } from "@/lib/control/http.mjs";
import { createControlDb } from "@/lib/control/supabase-db.mjs";
import { withProcessingTables } from "@/lib/control/processing-db.mjs";
import { listGatewayResponses, listResponseTypes } from "@/lib/control/gateway-responses.mjs";

export const runtime = "nodejs";

const deps = {
  createControlDb: (client, options) => withProcessingTables(createControlDb(client, options), client),
};

export const GET = route(
  async ({ db, actor, projectId, params }) => {
    const customized = await listGatewayResponses(db, actor, { projectId, apiId: params.apiId });
    return listResponseTypes(customized);
  },
  { permission: "pods.apis.view", deps },
);
