import { route } from "@/lib/control/http.mjs";
import { getStageThrottle, updateStageThrottle } from "@/lib/control/usage-plans.mjs";

export const runtime = "nodejs";

export const GET = route(
  async ({ db, actor, projectId, params }) =>
    getStageThrottle(db, actor, {
      projectId,
      apiId: params.apiId,
      stageName: params.stageName,
    }),
  { permission: "pods.apis.view" },
);

export const PUT = route(
  async ({ db, actor, projectId, params, body, version, requestId }) =>
    updateStageThrottle(db, actor, {
      projectId,
      apiId: params.apiId,
      stageName: params.stageName,
      defaultThrottle: body?.defaultThrottle,
      throttles: body?.throttles,
      expectedVersion: version,
      requestId,
    }),
  { permission: "pods.stage.write" },
);
