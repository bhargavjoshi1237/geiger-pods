import { route } from "@/lib/control/http.mjs";
import { createControlDb } from "@/lib/control/supabase-db.mjs";
import { withDistributionTables } from "@/lib/control/distribution-db.mjs";
import { setStageDocumentationVersion } from "@/lib/control/documentation.mjs";

export const runtime = "nodejs";

const deps = {
  createControlDb: (client, options) => withDistributionTables(createControlDb(client, options), client),
};

export const PUT = route(
  async ({ db, actor, projectId, params, body, requestId }) =>
    setStageDocumentationVersion(db, actor, {
      projectId,
      apiId: params.apiId,
      stageName: params.stageName,
      version: body?.version ?? null,
      requestId,
    }),
  { permission: "pods.stage.write", deps },
);
