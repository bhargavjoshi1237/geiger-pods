import { route } from "@/lib/control/http.mjs";
import { deleteResource, renameResource } from "@/lib/control/rest-resources.mjs";

export const runtime = "nodejs";

export const PATCH = route(
  async ({ db, actor, projectId, params, body, version, requestId }) =>
    renameResource(db, actor, {
      projectId,
      apiId: params.apiId,
      resourceId: params.resourceId,
      pathPart: body?.pathPart,
      expectedVersion: version,
      requestId,
    }),
);

export const DELETE = route(
  async ({ db, actor, projectId, params, url, requestId }) =>
    deleteResource(db, actor, {
      projectId,
      apiId: params.apiId,
      resourceId: params.resourceId,
      recursive: url.searchParams.get("recursive") === "true",
      requestId,
    }),
);
