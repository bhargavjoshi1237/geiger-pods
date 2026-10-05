import { route } from "@/lib/control/http.mjs";
import { createControlDb } from "@/lib/control/supabase-db.mjs";
import { withProcessingTables } from "@/lib/control/processing-db.mjs";
import { getCors, putCors } from "@/lib/control/cors.mjs";

export const runtime = "nodejs";

const deps = {
  createControlDb: (client, options) => withProcessingTables(createControlDb(client, options), client),
};

export const GET = route(
  async ({ db, actor, projectId, params }) => getCors(db, actor, {
    projectId,
    apiId: params.apiId,
  }),
  { permission: "pods.apis.view", deps },
);

export const PUT = route(
  async ({ db, actor, projectId, params, body, version, requestId }) => putCors(db, actor, {
    projectId,
    apiId: params.apiId,
    input: body,
    expectedVersion: version,
    requestId,
  }),
  { permission: "pods.api.update", deps },
);

export const DELETE = route(
  async ({ db, actor, projectId, params, version, requestId }) => putCors(db, actor, {
    projectId,
    apiId: params.apiId,
    input: null,
    expectedVersion: version,
    requestId,
  }),
  { permission: "pods.api.update", deps },
);
