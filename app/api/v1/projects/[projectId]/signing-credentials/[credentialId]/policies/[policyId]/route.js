import { route } from "@/lib/control/http.mjs";
import { createControlDb } from "@/lib/control/supabase-db.mjs";
import { withAuthTables } from "@/lib/control/auth-db.mjs";
import { updateSigningPolicy, deleteSigningPolicy } from "@/lib/control/signing-credentials.mjs";

export const runtime = "nodejs";

const deps = {
  createControlDb: (client, options) => withAuthTables(createControlDb(client, options), client),
};

export const PUT = route(
  async ({ db, actor, projectId, params, body, version, requestId }) => updateSigningPolicy(db, actor, {
    projectId,
    credentialId: params.credentialId,
    policyId: params.policyId,
    document: body?.document,
    expectedVersion: version,
    requestId,
  }),
  { deps },
);

export const DELETE = route(
  async ({ db, actor, projectId, params, requestId }) => deleteSigningPolicy(db, actor, {
    projectId,
    credentialId: params.credentialId,
    policyId: params.policyId,
    requestId,
  }),
  { deps },
);
