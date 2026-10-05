import { route } from "@/lib/control/http.mjs";
import { deleteCanary, getCanary, putCanary } from "@/lib/control/canary.mjs";

export const runtime = "nodejs";

export const GET = route(
  async ({ db, actor, projectId, params }) =>
    getCanary(db, actor, {
      projectId,
      apiId: params.apiId,
      stageName: params.stageName,
    }),
);

export const PUT = route(
  async ({ db, actor, projectId, params, body, requestId }) =>
    putCanary(db, actor, {
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
    deleteCanary(db, actor, {
      projectId,
      apiId: params.apiId,
      stageName: params.stageName,
      requestId,
    }),
  { permission: "pods.stage.write" },
);
