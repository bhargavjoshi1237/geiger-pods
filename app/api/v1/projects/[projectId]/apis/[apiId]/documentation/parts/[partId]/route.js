import { route } from "@/lib/control/http.mjs";
import { createControlDb } from "@/lib/control/supabase-db.mjs";
import { withDistributionTables } from "@/lib/control/distribution-db.mjs";
import { deleteDocumentationPart, updateDocumentationPart } from "@/lib/control/documentation.mjs";

export const runtime = "nodejs";

const deps = {
  createControlDb: (client, options) => withDistributionTables(createControlDb(client, options), client),
};

export const PATCH = route(
  async ({ db, actor, projectId, params, body, version, requestId }) =>
    updateDocumentationPart(db, actor, {
      projectId,
      apiId: params.apiId,
      partId: params.partId,
      properties: body?.properties,
      expectedVersion: version,
      requestId,
    }),
  { permission: "pods.documentation.write", deps },
);

export const DELETE = route(
  async ({ db, actor, projectId, params, requestId }) =>
    deleteDocumentationPart(db, actor, {
      projectId,
      apiId: params.apiId,
      partId: params.partId,
      requestId,
    }),
  { permission: "pods.documentation.write", deps },
);
