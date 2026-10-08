import { route } from "@/lib/control/http.mjs";
import { createControlDb } from "@/lib/control/supabase-db.mjs";
import { withDistributionTables } from "@/lib/control/distribution-db.mjs";
import { createDocumentationPart, listDocumentationParts } from "@/lib/control/documentation.mjs";

export const runtime = "nodejs";

const deps = {
  createControlDb: (client, options) => withDistributionTables(createControlDb(client, options), client),
};

export const GET = route(
  async ({ db, actor, projectId, params }) =>
    listDocumentationParts(db, actor, { projectId, apiId: params.apiId }),
  { permission: "pods.apis.view", deps },
);

export const POST = route(
  async ({ db, actor, projectId, params, body, requestId }) =>
    createDocumentationPart(db, actor, {
      projectId,
      apiId: params.apiId,
      location: body?.location,
      properties: body?.properties,
      requestId,
    }),
  { permission: "pods.documentation.write", deps },
);
