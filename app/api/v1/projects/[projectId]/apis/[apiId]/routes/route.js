import { route } from "@/lib/control/http.mjs";
import { createRoute, listRoutes } from "@/lib/control/http-routes.mjs";

export const runtime = "nodejs";

export const GET = route(
  async ({ db, actor, projectId, params, url }) =>
    listRoutes(db, actor, {
      projectId,
      apiId: params.apiId,
      limit: url.searchParams.get("limit") ?? undefined,
      cursor: url.searchParams.get("cursor"),
    }),
);

export const POST = route(
  async ({ db, actor, projectId, params, body, requestId }) =>
    createRoute(db, actor, { projectId, apiId: params.apiId, requestId, ...(body ?? {}) }),
);
