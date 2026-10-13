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
  // Stages and deployments have no delete policy for `authenticated`; the
  // adapter deletes with the service role after this permission check.
  { permission: "pods.stage.delete", needsService: true },
);
