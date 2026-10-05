import { route } from "@/lib/control/http.mjs";
import { createControlDb } from "@/lib/control/supabase-db.mjs";
import { withProcessingTables } from "@/lib/control/processing-db.mjs";
import { listModels, createModel } from "@/lib/control/models.mjs";

export const runtime = "nodejs";

const deps = {
  createControlDb: (client, options) => withProcessingTables(createControlDb(client, options), client),
};

export const GET = route(
  async ({ db, actor, projectId, params, url }) => listModels(db, actor, {
    projectId,
    apiId: params.apiId,
    limit: url.searchParams.get("limit") ?? 25,
    cursor: url.searchParams.get("cursor"),
  }),
  { permission: "pods.apis.view", deps },
);

export const POST = route(
  async ({ db, actor, projectId, params, body, requestId }) => createModel(db, actor, {
    projectId,
    apiId: params.apiId,
    input: body,
    requestId,
  }),
  { permission: "pods.model.write", deps },
);
