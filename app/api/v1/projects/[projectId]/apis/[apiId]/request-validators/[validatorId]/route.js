import { route } from "@/lib/control/http.mjs";
import { createControlDb } from "@/lib/control/supabase-db.mjs";
import { withProcessingTables } from "@/lib/control/processing-db.mjs";
import { getRequestValidator, updateRequestValidator, deleteRequestValidator } from "@/lib/control/request-validators.mjs";

export const runtime = "nodejs";

const deps = {
  createControlDb: (client, options) => withProcessingTables(createControlDb(client, options), client),
};

export const GET = route(
  async ({ db, actor, projectId, params }) => getRequestValidator(db, actor, {
    projectId,
    apiId: params.apiId,
    validatorId: params.validatorId,
  }),
  { permission: "pods.apis.view", deps },
);

export const PATCH = route(
  async ({ db, actor, projectId, params, body, version, requestId }) => updateRequestValidator(db, actor, {
    projectId,
    apiId: params.apiId,
    validatorId: params.validatorId,
    patch: body,
    expectedVersion: version,
    requestId,
  }),
  { permission: "pods.model.write", deps },
);

export const DELETE = route(
  async ({ db, actor, projectId, params, version, requestId }) => deleteRequestValidator(db, actor, {
    projectId,
    apiId: params.apiId,
    validatorId: params.validatorId,
    expectedVersion: version,
    requestId,
  }),
  { permission: "pods.model.write", deps },
);
