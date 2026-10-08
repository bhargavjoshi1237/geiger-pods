import { route } from "@/lib/control/http.mjs";
import { deleteRouteResponse } from "@/lib/control/route-responses.mjs";

export const runtime = "nodejs";

export const DELETE = route(
  async ({ db, actor, projectId, params, requestId }) =>
    deleteRouteResponse(db, actor, {
      projectId,
      apiId: params.apiId,
      routeId: params.routeId,
      responseId: params.responseId,
      requestId,
    }),
  { permission: "pods.route.write" },
);
