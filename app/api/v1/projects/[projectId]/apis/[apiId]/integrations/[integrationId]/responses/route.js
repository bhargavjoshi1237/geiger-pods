import { route } from "@/lib/control/http.mjs";
import { createIntegrationResponse, listIntegrationResponses } from "@/lib/control/integrations.mjs";

export const runtime = "nodejs";

export const GET = route(
  async ({ db, actor, projectId, params }) =>
    listIntegrationResponses(db, actor, {
      projectId,
      apiId: params.apiId,
      integrationId: params.integrationId,
    }),
  { permission: "pods.integration.write" },
);

export const POST = route(
  async ({ db, actor, projectId, params, body, requestId }) =>
    createIntegrationResponse(db, actor, {
      projectId,
      apiId: params.apiId,
      integrationId: params.integrationId,
      input: body,
      requestId,
    }),
  { permission: "pods.integration.write" },
);
