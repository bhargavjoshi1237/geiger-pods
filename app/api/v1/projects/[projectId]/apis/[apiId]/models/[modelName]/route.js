import { route } from "@/lib/control/http.mjs";
import { createControlDb } from "@/lib/control/supabase-db.mjs";
import { withProcessingTables } from "@/lib/control/processing-db.mjs";
import { getModel, updateModel, deleteModel } from "@/lib/control/models.mjs";

export const runtime = "nodejs";

const deps = {
  createControlDb: (client, options) => withProcessingTables(createControlDb(client, options), client),
};

function target(params) {
  return { apiId: params.apiId, name: params.modelName };
}

export const GET = route(
  async ({ db, actor, projectId, params }) => getModel(db, actor, { projectId, ...target(params) }),
  { permission: "pods.apis.view", deps },
);

export const PATCH = route(
  async ({ db, actor, projectId, params, body, version, requestId }) => updateModel(db, actor, {
    projectId,
    ...target(params),
    patch: body,
    expectedVersion: version,
    requestId,
  }),
  { permission: "pods.model.write", deps },
);

export const DELETE = route(
  async ({ db, actor, projectId, params, version, requestId }) => deleteModel(db, actor, {
    projectId,
    ...target(params),
    expectedVersion: version,
    requestId,
  }),
  { permission: "pods.model.write", deps },
);
