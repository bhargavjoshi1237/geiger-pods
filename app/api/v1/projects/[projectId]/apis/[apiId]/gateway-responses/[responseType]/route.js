import { route } from "@/lib/control/http.mjs";
import { createControlDb } from "@/lib/control/supabase-db.mjs";
import { withProcessingTables } from "@/lib/control/processing-db.mjs";
import { getGatewayResponse, putGatewayResponse, resetGatewayResponse } from "@/lib/control/gateway-responses.mjs";

export const runtime = "nodejs";

const deps = {
  createControlDb: (client, options) => withProcessingTables(createControlDb(client, options), client),
};

export const GET = route(
  async ({ db, actor, projectId, params }) => getGatewayResponse(db, actor, {
    projectId,
    apiId: params.apiId,
    responseType: params.responseType,
  }),
  { permission: "pods.apis.view", deps },
);

export const PUT = route(
  async ({ db, actor, projectId, params, body, version, requestId }) => putGatewayResponse(db, actor, {
    projectId,
    apiId: params.apiId,
    responseType: params.responseType,
    input: body,
    expectedVersion: version,
    requestId,
  }),
  { permission: "pods.gateway_response.write", deps },
);

export const DELETE = route(
  async ({ db, actor, projectId, params, requestId }) => resetGatewayResponse(db, actor, {
    projectId,
    apiId: params.apiId,
    responseType: params.responseType,
    requestId,
  }),
  { permission: "pods.gateway_response.write", deps },
);
