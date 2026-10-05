import { route } from "@/lib/control/http.mjs";
import { createControlDb } from "@/lib/control/supabase-db.mjs";
import { withAuthTables } from "@/lib/control/auth-db.mjs";
import { listAuthorizers, createAuthorizer } from "@/lib/control/authorizers.mjs";

export const runtime = "nodejs";

const deps = {
  createControlDb: (client, options) => withAuthTables(createControlDb(client, options), client),
};

export const GET = route(
  async ({ db, actor, projectId, params, url }) => listAuthorizers(db, actor, {
    projectId,
    apiId: params.apiId,
    limit: url.searchParams.get("limit") ?? 25,
    cursor: url.searchParams.get("cursor"),
  }),
  { deps },
);

export const POST = route(
  async ({ db, actor, projectId, params, body, requestId }) => createAuthorizer(db, actor, {
    projectId,
    apiId: params.apiId,
    input: body,
    requestId,
  }),
  { deps },
);
