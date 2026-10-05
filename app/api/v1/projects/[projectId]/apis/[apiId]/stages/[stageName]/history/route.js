import { route } from "@/lib/control/http.mjs";
import { listStageHistory } from "@/lib/control/stages.mjs";

export const runtime = "nodejs";

export const GET = route(
  async ({ db, actor, projectId, params }) =>
    listStageHistory(db, actor, {
      projectId,
      apiId: params.apiId,
      stageName: params.stageName,
    }),
);
