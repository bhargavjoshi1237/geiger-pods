import { route } from "@/lib/control/http.mjs";
import { diffDeployments } from "@/lib/control/deployments.mjs";

export const runtime = "nodejs";

export const GET = route(
  async ({ db, actor, projectId, params }) =>
    diffDeployments(db, actor, {
      projectId,
      apiId: params.apiId,
      deploymentIdA: params.deploymentId,
      deploymentIdB: params.otherId,
    }),
);
