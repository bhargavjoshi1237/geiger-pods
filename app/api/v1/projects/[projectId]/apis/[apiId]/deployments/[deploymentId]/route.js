import { route } from "@/lib/control/http.mjs";
import { deleteDeployment, getDeployment } from "@/lib/control/deployments.mjs";

export const runtime = "nodejs";

export const GET = route(
  async ({ db, actor, projectId, params }) =>
    getDeployment(db, actor, {
      projectId,
      apiId: params.apiId,
      deploymentId: params.deploymentId,
    }),
);

export const DELETE = route(
  async ({ db, actor, projectId, params, requestId }) =>
    deleteDeployment(db, actor, {
      projectId,
      apiId: params.apiId,
      deploymentId: params.deploymentId,
      requestId,
    }),
  { permission: "pods.stage.delete" },
);
