import { route } from "@/lib/control/http.mjs";
import { createControlDb } from "@/lib/control/supabase-db.mjs";
import { withProcessingTables } from "@/lib/control/processing-db.mjs";
import { listRequestValidators, createRequestValidator } from "@/lib/control/request-validators.mjs";

export const runtime = "nodejs";

const deps = {
  createControlDb: (client, options) => withProcessingTables(createControlDb(client, options), client),
};

export const GET = route(
  async ({ db, actor, projectId, params }) => listRequestValidators(db, actor, {
    projectId,
    apiId: params.apiId,
  }),
  { permission: "pods.apis.view", deps },
);

export const POST = route(
  async ({ db, actor, projectId, params, body, requestId }) => createRequestValidator(db, actor, {
    projectId,
    apiId: params.apiId,
    input: body,
    requestId,
  }),
  { permission: "pods.model.write", deps },
);
