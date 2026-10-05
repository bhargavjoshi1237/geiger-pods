import { route } from "@/lib/control/http.mjs";
import { deleteApi, getApi, updateApi } from "@/lib/control/apis.mjs";

export const runtime = "nodejs";

export const GET = route(
  async ({ db, actor, projectId, params }) => getApi(db, actor, { projectId, apiId: params.apiId }),
);

export const PATCH = route(
  async ({ db, actor, projectId, params, body, version, requestId }) =>
    updateApi(db, actor, { projectId, apiId: params.apiId, patch: body, expectedVersion: version, requestId }),
);

export const DELETE = route(
  async ({ db, actor, projectId, params, requestId }) =>
    deleteApi(db, actor, { projectId, apiId: params.apiId, requestId }),
);
