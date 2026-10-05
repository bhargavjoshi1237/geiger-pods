import { route } from "@/lib/control/http.mjs";
import { createStage, listStages } from "@/lib/control/stages.mjs";

export const runtime = "nodejs";

export const GET = route(
  async ({ db, actor, projectId, params }) =>
    listStages(db, actor, { projectId, apiId: params.apiId }),
);

export const POST = route(
  async ({ db, actor, projectId, params, body, requestId }) =>
    createStage(db, actor, {
      projectId,
      apiId: params.apiId,
      input: body ?? {},
      requestId,
    }),
  { permission: "pods.stage.write" },
);
