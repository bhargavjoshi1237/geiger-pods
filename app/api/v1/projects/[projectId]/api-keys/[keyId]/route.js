import { route } from "@/lib/control/http.mjs";
import { createServerSupabase } from "@/lib/supabase/server.js";
import { withUsageDb } from "@/lib/control/usage-db.mjs";
import { getUsageKv } from "@/lib/control/usage-kv.mjs";
import { deleteApiKey, getApiKey, revealApiKey, updateApiKey } from "@/lib/control/api-keys.mjs";

export const runtime = "nodejs";

async function usageDb(db) {
  return withUsageDb(db, await createServerSupabase());
}

// ?includeValue=true reveals the value (needs pods.api_key.reveal, audited);
// otherwise key metadata. The service enforces the reveal permission.
export const GET = route(
  async ({ db, actor, projectId, params, url }) => {
    const store = await usageDb(db);
    if (url.searchParams.get("includeValue") === "true") {
      return revealApiKey(store, actor, { projectId, keyId: params.keyId });
    }
    return getApiKey(store, actor, { projectId, keyId: params.keyId });
  },
  { permission: "pods.api_key.write", needsService: true },
);

export const PATCH = route(
  async ({ db, actor, projectId, params, body, version, requestId }) =>
    updateApiKey(await usageDb(db), actor, {
      projectId,
      keyId: params.keyId,
      patch: body ?? {},
      expectedVersion: version,
      requestId,
    }, { kv: await getUsageKv() }),
  { permission: "pods.api_key.write" },
);

export const DELETE = route(
  async ({ db, actor, projectId, params, requestId }) =>
    deleteApiKey(await usageDb(db), actor, {
      projectId,
      keyId: params.keyId,
      requestId,
    }, { kv: await getUsageKv() }),
  { permission: "pods.api_key.write" },
);
