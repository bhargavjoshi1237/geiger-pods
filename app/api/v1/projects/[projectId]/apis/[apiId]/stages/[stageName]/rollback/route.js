import { route } from "@/lib/control/http.mjs";
import { rollbackStage } from "@/lib/control/stages.mjs";

export const runtime = "nodejs";

export const POST = route(
  async ({ db, actor, projectId, params, body, version, requestId }) =>
    rollbackStage(db, actor, {
      projectId,
      apiId: params.apiId,
      stageName: params.stageName,
      deploymentId: body?.deploymentId,
      expectedVersion: version,
      requestId,
    }),
  { permission: "pods.stage.promote" },
);
