import { route } from "@/lib/control/http.mjs";
import { createControlDb } from "@/lib/control/supabase-db.mjs";
import { withDistributionTables } from "@/lib/control/distribution-db.mjs";
import { getDocumentationVersion } from "@/lib/control/documentation.mjs";

export const runtime = "nodejs";

const deps = {
  createControlDb: (client, options) => withDistributionTables(createControlDb(client, options), client),
};

export const GET = route(
  async ({ db, actor, projectId, params }) =>
    getDocumentationVersion(db, actor, { projectId, apiId: params.apiId, version: params.version }),
  { permission: "pods.apis.view", deps },
);
