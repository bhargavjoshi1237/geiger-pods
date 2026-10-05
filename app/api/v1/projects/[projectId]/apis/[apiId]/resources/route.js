import { route } from "@/lib/control/http.mjs";
import { createResource, listResources } from "@/lib/control/rest-resources.mjs";

export const runtime = "nodejs";

export const GET = route(
  async ({ db, actor, projectId, params, url }) =>
    listResources(db, actor, {
      projectId,
      apiId: params.apiId,
      limit: url.searchParams.get("limit") ?? undefined,
      cursor: url.searchParams.get("cursor"),
    }),
);

export const POST = route(
  async ({ db, actor, projectId, params, body, requestId }) =>
    createResource(db, actor, {
      projectId,
      apiId: params.apiId,
      parentId: body?.parentId,
      pathPart: body?.pathPart,
      requestId,
    }),
);
