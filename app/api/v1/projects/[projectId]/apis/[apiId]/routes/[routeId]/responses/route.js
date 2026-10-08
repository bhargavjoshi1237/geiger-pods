import { route } from "@/lib/control/http.mjs";
import { createRouteResponse, listRouteResponses } from "@/lib/control/route-responses.mjs";

export const runtime = "nodejs";

export const GET = route(
  async ({ db, actor, projectId, params }) =>
    listRouteResponses(db, actor, {
      projectId,
      apiId: params.apiId,
      routeId: params.routeId,
    }),
);

export const POST = route(
  async ({ db, actor, projectId, params, body, requestId }) =>
    createRouteResponse(db, actor, {
      projectId,
      apiId: params.apiId,
      routeId: params.routeId,
      routeResponseKey: body?.routeResponseKey ?? "$default",
      responseModels: body?.responseModels,
      modelSelectionExpression: body?.modelSelectionExpression,
      requestId,
    }),
  { permission: "pods.route.write" },
);
