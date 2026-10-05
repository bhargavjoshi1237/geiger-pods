import { route } from "@/lib/control/http.mjs";
import { createControlDb } from "@/lib/control/supabase-db.mjs";
import { withAuthTables } from "@/lib/control/auth-db.mjs";
import { getAuthorizer, updateAuthorizer, deleteAuthorizer } from "@/lib/control/authorizers.mjs";

export const runtime = "nodejs";

const deps = {
  createControlDb: (client, options) => withAuthTables(createControlDb(client, options), client),
};

export const GET = route(
  async ({ db, actor, projectId, params }) => getAuthorizer(db, actor, {
    projectId,
    apiId: params.apiId,
    authorizerId: params.authorizerId,
  }),
  { deps },
);

export const PATCH = route(
  async ({ db, actor, projectId, params, body, version, requestId }) => updateAuthorizer(db, actor, {
    projectId,
    apiId: params.apiId,
    authorizerId: params.authorizerId,
    patch: body,
    expectedVersion: version,
    requestId,
  }),
  { deps },
);

export const DELETE = route(
  async ({ db, actor, projectId, params, requestId }) => deleteAuthorizer(db, actor, {
    projectId,
    apiId: params.apiId,
    authorizerId: params.authorizerId,
    requestId,
  }),
  { deps },
);
