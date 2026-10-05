import { route } from "@/lib/control/http.mjs";
import { createControlDb } from "@/lib/control/supabase-db.mjs";
import { withAuthTables } from "@/lib/control/auth-db.mjs";
import { getSigningCredential, updateSigningCredential, deleteSigningCredential } from "@/lib/control/signing-credentials.mjs";

export const runtime = "nodejs";

const deps = {
  createControlDb: (client, options) => withAuthTables(createControlDb(client, options), client),
};

export const GET = route(
  async ({ db, actor, projectId, params }) => getSigningCredential(db, actor, {
    projectId,
    credentialId: params.credentialId,
  }),
  { deps },
);

export const PATCH = route(
  async ({ db, actor, projectId, params, body, version, requestId }) => updateSigningCredential(db, actor, {
    projectId,
    credentialId: params.credentialId,
    patch: body,
    expectedVersion: version,
    requestId,
  }),
  { deps },
);

export const DELETE = route(
  async ({ db, actor, projectId, params, requestId }) => deleteSigningCredential(db, actor, {
    projectId,
    credentialId: params.credentialId,
    requestId,
  }),
  { deps },
);
