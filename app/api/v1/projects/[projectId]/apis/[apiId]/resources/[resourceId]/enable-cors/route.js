import { route } from "@/lib/control/http.mjs";
import { createControlDb } from "@/lib/control/supabase-db.mjs";
import { withProcessingTables } from "@/lib/control/processing-db.mjs";
import { enableCors } from "@/lib/control/enable-cors.mjs";

export const runtime = "nodejs";

const deps = {
  createControlDb: (client, options) => withProcessingTables(createControlDb(client, options), client),
};

export const POST = route(
  async ({ db, actor, projectId, params, body, requestId }) =>
    enableCors(db, actor, {
      projectId,
      apiId: params.apiId,
      resourceId: params.resourceId,
      input: body ?? {},
      requestId,
    }),
  { permission: "pods.route.write", deps },
);
