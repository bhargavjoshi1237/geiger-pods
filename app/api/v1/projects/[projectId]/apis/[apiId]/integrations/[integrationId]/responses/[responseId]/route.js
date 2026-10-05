import { route } from "@/lib/control/http.mjs";
import { deleteIntegrationResponse } from "@/lib/control/integrations.mjs";

export const runtime = "nodejs";

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
