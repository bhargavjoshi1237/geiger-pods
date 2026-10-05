import { route } from "@/lib/control/http.mjs";
import { createControlDb } from "@/lib/control/supabase-db.mjs";
import { withObservabilityTables } from "@/lib/control/observe-db.mjs";
import { updateStageLogging } from "@/lib/control/logs.mjs";
import { getStage } from "@/lib/control/stages.mjs";

export const runtime = "nodejs";

const deps = { createControlDb: (client, opts) => withObservabilityTables(createControlDb(client, opts), client) };

export const GET = route(
  async ({ db, actor, projectId, params }) => {
    const stage = await getStage(db, actor, { projectId, apiId: params.apiId, stageName: params.stageName });
    return {
      accessLog: stage.accessLog,
      methodSettings: stage.methodSettings,
      routeSettings: stage.routeSettings,
      tracingEnabled: stage.tracingEnabled,
    };
  },
  { deps },
);

export const PUT = route(
  async ({ db, actor, projectId, params, body, requestId }) =>
    updateStageLogging(db, actor, {
      projectId,
      apiId: params.apiId,
      stageName: params.stageName,
      input: body,
      requestId,
    }),
  { deps },
);
