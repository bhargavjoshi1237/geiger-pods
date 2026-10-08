import { route } from "@/lib/control/http.mjs";
import { getAgentTools, putAgentTools } from "@/lib/control/agent-tools.mjs";

export const runtime = "nodejs";

export const GET = route(
  async ({ db, actor, projectId, params }) =>
    getAgentTools(db, actor, { projectId, apiId: params.apiId, stageName: params.stageName }),
  { permission: "pods.apis.view" },
);

export const PUT = route(
  async ({ db, actor, projectId, params, body, requestId }) =>
    putAgentTools(db, actor, {
      projectId,
      apiId: params.apiId,
      stageName: params.stageName,
      agentTools: body?.agentTools ?? body ?? null,
      requestId,
    }),
  { permission: "pods.stage.write" },
);
