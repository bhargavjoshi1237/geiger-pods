import { route } from "@/lib/control/http.mjs";
import { deleteTags, getTags, putTags } from "@/lib/control/tags.mjs";

export const runtime = "nodejs";

export const GET = route(
  async ({ db, actor, projectId, params }) =>
    getTags(db, actor, {
      projectId,
      resourceType: params.resourceType,
      resourceId: params.resourceId,
    }),
  { permission: "pods.apis.view" },
);

export const PUT = route(
  async ({ db, actor, projectId, params, body, requestId }) =>
    putTags(db, actor, {
      projectId,
      resourceType: params.resourceType,
      resourceId: params.resourceId,
      tags: body?.tags ?? body,
      requestId,
    }),
  { permission: "pods.api.update" },
);

export const DELETE = route(
  async ({ db, actor, projectId, params, requestId }) =>
    deleteTags(db, actor, {
      projectId,
      resourceType: params.resourceType,
      resourceId: params.resourceId,
      requestId,
    }),
  { permission: "pods.api.update" },
);
