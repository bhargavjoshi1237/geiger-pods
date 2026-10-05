import { route } from "@/lib/control/http.mjs";
import { deleteRoute, getRoute, updateRoute } from "@/lib/control/http-routes.mjs";

export const runtime = "nodejs";

export const GET = route(
  async ({ db, actor, projectId, params }) =>
    getRoute(db, actor, { projectId, apiId: params.apiId, routeId: params.routeId }),
);

export const PATCH = route(
  async ({ db, actor, projectId, params, body, version, requestId }) =>
    updateRoute(db, actor, {
      projectId,
      apiId: params.apiId,
      routeId: params.routeId,
      patch: body,
      expectedVersion: version,
      requestId,
    }),
);

export const DELETE = route(
  async ({ db, actor, projectId, params, requestId }) =>
    deleteRoute(db, actor, { projectId, apiId: params.apiId, routeId: params.routeId, requestId }),
);
