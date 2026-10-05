import { route } from "@/lib/control/http.mjs";
import { createControlDb } from "@/lib/control/supabase-db.mjs";
import { withAuthTables } from "@/lib/control/auth-db.mjs";
import { listSigningPolicies, createSigningPolicy } from "@/lib/control/signing-credentials.mjs";

export const runtime = "nodejs";

const deps = {
  createControlDb: (client, options) => withAuthTables(createControlDb(client, options), client),
};

export const GET = route(
  async ({ db, actor, projectId, params }) => listSigningPolicies(db, actor, {
    projectId,
    credentialId: params.credentialId,
  }),
  { deps },
);

export const POST = route(
  async ({ db, actor, projectId, params, body, requestId }) => createSigningPolicy(db, actor, {
    projectId,
    credentialId: params.credentialId,
    name: body?.name,
    document: body?.document,
    requestId,
  }),
  { deps },
);
