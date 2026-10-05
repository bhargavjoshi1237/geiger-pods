import { route } from "@/lib/control/http.mjs";
import { createServerSupabase } from "@/lib/supabase/server.js";
import { withUsageDb } from "@/lib/control/usage-db.mjs";
import { getUsageKv } from "@/lib/control/usage-kv.mjs";
import { rotateApiKey } from "@/lib/control/api-keys.mjs";

export const runtime = "nodejs";

// Rotate: new key copying name (suffixed), plans and tags; the old key stays
// enabled. The new value is returned once.
export const POST = route(
  async ({ db, actor, projectId, params, requestId }) =>
    rotateApiKey(await withUsageDb(db, await createServerSupabase()), actor, {
      projectId,
      keyId: params.keyId,
      requestId,
    }, { kv: await getUsageKv() }),
  { permission: "pods.api_key.write", needsService: true },
);
