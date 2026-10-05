import { route } from "@/lib/control/http.mjs";
import { createControlDb } from "@/lib/control/supabase-db.mjs";
import { withProcessingTables } from "@/lib/control/processing-db.mjs";
import { listMethodResponses, createMethodResponse } from "@/lib/control/method-responses.mjs";

export const runtime = "nodejs";

const deps = {
  createControlDb: (client, options) => withProcessingTables(createControlDb(client, options), client),
};

export const GET = route(
  async ({ db, actor, projectId, params }) => listMethodResponses(db, actor, {
    projectId,
    apiId: params.apiId,
    methodId: params.methodId,
  }),
  { permission: "pods.apis.view", deps },
);

export const POST = route(
  async ({ db, actor, projectId, params, body, requestId }) => createMethodResponse(db, actor, {
    projectId,
    apiId: params.apiId,
    methodId: params.methodId,
    input: body,
    requestId,
  }),
  { permission: "pods.route.write", deps },
);
