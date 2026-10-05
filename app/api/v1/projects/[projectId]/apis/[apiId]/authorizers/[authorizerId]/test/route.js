import { route } from "@/lib/control/http.mjs";
import { createControlDb } from "@/lib/control/supabase-db.mjs";
import { withAuthTables } from "@/lib/control/auth-db.mjs";
import { testAuthorizer } from "@/lib/control/authorizers.mjs";

export const runtime = "nodejs";

const deps = {
  createControlDb: (client, options) => withAuthTables(createControlDb(client, options), client),
};

export const POST = route(
  async ({ db, actor, projectId, params, body, requestId }) => testAuthorizer(db, actor, {
    projectId,
    apiId: params.apiId,
    authorizerId: params.authorizerId,
    input: body,
    requestId,
  }),
  { deps },
);
