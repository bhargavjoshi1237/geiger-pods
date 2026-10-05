import { route } from "@/lib/control/http.mjs";
import { createControlDb } from "@/lib/control/supabase-db.mjs";
import { withProcessingTables } from "@/lib/control/processing-db.mjs";
import { getMethodResponse, updateMethodResponse, deleteMethodResponse } from "@/lib/control/method-responses.mjs";

export const runtime = "nodejs";

const deps = {
  createControlDb: (client, options) => withProcessingTables(createControlDb(client, options), client),
};

function target(params) {
  return { apiId: params.apiId, methodId: params.methodId, statusCode: params.statusCode };
}

export const GET = route(
  async ({ db, actor, projectId, params }) => getMethodResponse(db, actor, { projectId, ...target(params) }),
  { permission: "pods.apis.view", deps },
);

export const PATCH = route(
  async ({ db, actor, projectId, params, body, version, requestId }) => updateMethodResponse(db, actor, {
    projectId,
    ...target(params),
    patch: body,
    expectedVersion: version,
    requestId,
  }),
  { permission: "pods.route.write", deps },
);

export const DELETE = route(
  async ({ db, actor, projectId, params, version, requestId }) => deleteMethodResponse(db, actor, {
    projectId,
    ...target(params),
    expectedVersion: version,
    requestId,
  }),
  { permission: "pods.route.write", deps },
);
