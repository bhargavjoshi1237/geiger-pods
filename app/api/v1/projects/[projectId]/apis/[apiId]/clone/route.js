import { route } from "@/lib/control/http.mjs";
import { cloneApi } from "@/lib/control/apis.mjs";

export const runtime = "nodejs";

export const POST = route(
  async ({ db, actor, projectId, params, body, requestId }) =>
    cloneApi(db, actor, { projectId, apiId: params.apiId, name: body?.name, requestId }),
);
