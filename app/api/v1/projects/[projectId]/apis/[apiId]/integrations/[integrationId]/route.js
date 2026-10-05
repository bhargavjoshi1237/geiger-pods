import { route } from "@/lib/control/http.mjs";
import { deleteIntegration, getIntegration, updateIntegration } from "@/lib/control/integrations.mjs";

export const runtime = "nodejs";

export const GET = route(
  async ({ db, actor, projectId, params }) =>
    getIntegration(db, actor, {
      projectId,
      apiId: params.apiId,
      integrationId: params.integrationId,
    }),
  { permission: "pods.integration.write" },
);

export const PATCH = route(
  async ({ db, actor, projectId, params, body, version, requestId }) =>
    updateIntegration(db, actor, {
      projectId,
      apiId: params.apiId,
      integrationId: params.integrationId,
      patch: body,
      expectedVersion: version,
      requestId,
    }),
  { permission: "pods.integration.write" },
);

export const DELETE = route(
  async ({ db, actor, projectId, params, requestId }) =>
    deleteIntegration(db, actor, {
      projectId,
      apiId: params.apiId,
      integrationId: params.integrationId,
      requestId,
    }),
  { permission: "pods.integration.write" },
);
