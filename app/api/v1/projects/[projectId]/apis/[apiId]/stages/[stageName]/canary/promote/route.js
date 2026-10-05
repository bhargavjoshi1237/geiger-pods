import { route } from "@/lib/control/http.mjs";
import { promoteCanary } from "@/lib/control/canary.mjs";

export const runtime = "nodejs";

export const POST = route(
  async ({ db, actor, projectId, params, body, requestId }) =>
    promoteCanary(db, actor, {
      projectId,
      apiId: params.apiId,
      stageName: params.stageName,
      mergeVariables: body?.mergeVariables ?? false,
      removeCanary: body?.removeCanary ?? false,
      requestId,
    }),
  { permission: "pods.stage.promote" },
);
