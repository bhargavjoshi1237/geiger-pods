import { route } from "@/lib/control/http.mjs";
import { deleteStage, getStage, updateStagePointer } from "@/lib/control/stages.mjs";

export const runtime = "nodejs";

export const GET = route(
  async ({ db, actor, projectId, params }) =>
    getStage(db, actor, {
      projectId,
      apiId: params.apiId,
      stageName: params.stageName,
    }),
);

export const PATCH = route(
  async ({ db, actor, projectId, params, body, version, requestId }) =>
    updateStagePointer(db, actor, {
      projectId,
      apiId: params.apiId,
      stageName: params.stageName,
      deploymentId: body?.deploymentId,
      description: body?.description,
      variables: body?.variables,
      expectedVersion: version,
      requestId,
    }),
  { permission: "pods.stage.write" },
);

export const DELETE = route(
  async ({ db, actor, projectId, params, requestId }) =>
    deleteStage(db, actor, {
      projectId,
      apiId: params.apiId,
      stageName: params.stageName,
      requestId,
    }),
  { permission: "pods.stage.delete" },
);
