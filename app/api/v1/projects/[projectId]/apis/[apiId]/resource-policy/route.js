import { route } from "@/lib/control/http.mjs";
import { createControlDb } from "@/lib/control/supabase-db.mjs";
import { withAuthTables } from "@/lib/control/auth-db.mjs";
import { getResourcePolicy, updateResourcePolicy } from "@/lib/control/resource-policies.mjs";

export const runtime = "nodejs";

const deps = {
  createControlDb: (client, options) => withAuthTables(createControlDb(client, options), client),
};

export const GET = route(
  async ({ db, actor, projectId, params }) => getResourcePolicy(db, actor, {
    projectId,
    apiId: params.apiId,
  }),
  { deps },
);

export const PUT = route(
  async ({ db, actor, projectId, params, body, version, requestId }) => updateResourcePolicy(db, actor, {
    projectId,
    apiId: params.apiId,
    document: body?.document ?? null,
    expectedVersion: version,
    requestId,
  }),
  { deps },
);
