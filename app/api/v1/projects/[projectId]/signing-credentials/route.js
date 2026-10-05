import { route } from "@/lib/control/http.mjs";
import { createControlDb } from "@/lib/control/supabase-db.mjs";
import { withAuthTables } from "@/lib/control/auth-db.mjs";
import { listSigningCredentials, createSigningCredential } from "@/lib/control/signing-credentials.mjs";

export const runtime = "nodejs";

const deps = {
  createControlDb: (client, options) => withAuthTables(createControlDb(client, options), client),
};

export const GET = route(
  async ({ db, actor, projectId, url }) => listSigningCredentials(db, actor, {
    projectId,
    limit: url.searchParams.get("limit") ?? 25,
    cursor: url.searchParams.get("cursor"),
  }),
  { deps },
);

export const POST = route(
  async ({ db, actor, projectId, body, requestId }) => createSigningCredential(db, actor, {
    projectId,
    name: body?.name,
    tags: body?.tags,
    expiresAt: body?.expiresAt ?? null,
    requestId,
  }),
  { deps },
);
