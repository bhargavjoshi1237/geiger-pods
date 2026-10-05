import { route } from "@/lib/control/http.mjs";
import { deleteIntegrationResponse, getIntegrationResponse, updateIntegrationResponse } from "@/lib/control/integrations.mjs";

export const runtime = "nodejs";

export const GET = route(
  async ({ db, actor, projectId, params }) =>
    getIntegrationResponse(db, actor, {
      projectId,
      apiId: params.apiId,
      integrationId: params.integrationId,
      responseId: params.responseId,
    }),
  { permission: "pods.integration.write" },
);

export const PATCH = route(
  async ({ db, actor, projectId, params, body, version, requestId }) =>
    updateIntegrationResponse(db, actor, {
      projectId,
      apiId: params.apiId,
      integrationId: params.integrationId,
      responseId: params.responseId,
      patch: body,
      expectedVersion: version,
      requestId,
    }),
  { permission: "pods.integration.write" },
);

export const DELETE = route(
  async ({ db, actor, projectId, params, requestId }) =>
    deleteIntegrationResponse(db, actor, {
      projectId,
      apiId: params.apiId,
      integrationId: params.integrationId,
      responseId: params.responseId,
      requestId,
    }),
  { permission: "pods.integration.write" },
);
