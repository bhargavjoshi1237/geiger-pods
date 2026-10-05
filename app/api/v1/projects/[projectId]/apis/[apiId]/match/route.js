import { route } from "@/lib/control/http.mjs";
import { matchDraft } from "@/lib/control/apis.mjs";

export const runtime = "nodejs";

export const POST = route(
  async ({ db, actor, projectId, params, body }) =>
    matchDraft(db, actor, { projectId, apiId: params.apiId, method: body?.method, path: body?.path }),
);
