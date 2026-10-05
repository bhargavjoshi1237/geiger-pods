import { route } from "@/lib/control/http.mjs";
import { createIntegration, listIntegrations } from "@/lib/control/integrations.mjs";

export const runtime = "nodejs";

export const GET = route(
  async ({ db, actor, projectId, params, url }) =>
    listIntegrations(db, actor, {
      projectId,
      apiId: params.apiId,
      limit: url.searchParams.get("limit") ?? undefined,
      cursor: url.searchParams.get("cursor"),
    }),
  { permission: "pods.integration.write" },
);

export const POST = route(
  async ({ db, actor, projectId, params, body, requestId }) =>
    createIntegration(db, actor, {
      projectId,
      apiId: params.apiId,
      input: body,
      requestId,
    }),
  { permission: "pods.integration.write" },
);
