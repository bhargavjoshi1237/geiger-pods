import { route } from "@/lib/control/http.mjs";
import { flushStageCache, getStageCache, putStageCache } from "@/lib/control/stage-cache.mjs";

export const runtime = "nodejs";

export const GET = route(
  async ({ db, actor, projectId, params }) =>
    getStageCache(db, actor, {
      projectId,
      apiId: params.apiId,
      stageName: params.stageName,
    }),
);

export const PUT = route(
  async ({ db, actor, projectId, params, body, requestId }) =>
    putStageCache(db, actor, {
      projectId,
      apiId: params.apiId,
      stageName: params.stageName,
      input: body ?? {},
      requestId,
    }),
  { permission: "pods.stage.write" },
);

export const DELETE = route(
  async ({ db, actor, projectId, params, requestId }) =>
    flushStageCache(db, actor, {
      projectId,
      apiId: params.apiId,
      stageName: params.stageName,
      requestId,
    }),
  { permission: "pods.cache.flush" },
);
