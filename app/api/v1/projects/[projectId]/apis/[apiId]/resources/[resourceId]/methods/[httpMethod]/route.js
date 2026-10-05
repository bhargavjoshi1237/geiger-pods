import { route } from "@/lib/control/http.mjs";
import { deleteMethod, getMethod, patchMethod, putMethod } from "@/lib/control/rest-resources.mjs";

export const runtime = "nodejs";

function methodArgs(params) {
  return {
    apiId: params.apiId,
    resourceId: params.resourceId,
    httpMethod: params.httpMethod,
  };
}

export const GET = route(
  async ({ db, actor, projectId, params }) => getMethod(db, actor, { projectId, ...methodArgs(params) }),
);

export const PUT = route(
  async ({ db, actor, projectId, params, body, version, requestId }) =>
    putMethod(db, actor, {
      projectId,
      ...methodArgs(params),
      fields: body ?? {},
      expectedVersion: version,
      requestId,
    }),
);

export const PATCH = route(
  async ({ db, actor, projectId, params, body, version, requestId }) =>
    patchMethod(db, actor, {
      projectId,
      ...methodArgs(params),
      patch: body,
      expectedVersion: version,
      requestId,
    }),
);

export const DELETE = route(
  async ({ db, actor, projectId, params, requestId }) =>
    deleteMethod(db, actor, { projectId, ...methodArgs(params), requestId }),
);
