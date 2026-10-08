import { route } from "@/lib/control/http.mjs";
import { createControlDb } from "@/lib/control/supabase-db.mjs";
import { withDistributionTables } from "@/lib/control/distribution-db.mjs";
import { createDocumentationVersion, listDocumentationVersions } from "@/lib/control/documentation.mjs";

export const runtime = "nodejs";

const deps = {
  createControlDb: (client, options) => withDistributionTables(createControlDb(client, options), client),
};

export const GET = route(
  async ({ db, actor, projectId, params }) =>
    listDocumentationVersions(db, actor, { projectId, apiId: params.apiId }),
  { permission: "pods.apis.view", deps },
);

export const POST = route(
  async ({ db, actor, projectId, params, body, requestId }) =>
    createDocumentationVersion(db, actor, {
      projectId,
      apiId: params.apiId,
      version: body?.version,
      description: body?.description ?? "",
      requestId,
    }),
  { permission: "pods.documentation.write", deps },
);
