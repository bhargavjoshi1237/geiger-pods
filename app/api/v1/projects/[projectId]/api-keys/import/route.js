import { route } from "@/lib/control/http.mjs";
import { createServerSupabase } from "@/lib/supabase/server.js";
import { withUsageDb } from "@/lib/control/usage-db.mjs";
import { getUsageKv } from "@/lib/control/usage-kv.mjs";
import { importApiKeys } from "@/lib/control/api-keys.mjs";

export const runtime = "nodejs";

// Bulk import from AWS-format CSV (sent as a JSON string field, matching the
// JSON-only management API convention): { csv, failOnWarnings? }.
export const POST = route(
  async ({ db, actor, projectId, body, requestId }) =>
    importApiKeys(await withUsageDb(db, await createServerSupabase()), actor, {
      projectId,
      csv: body?.csv,
      failOnWarnings: body?.failOnWarnings ?? false,
      requestId,
    }, { kv: await getUsageKv() }),
  { permission: "pods.api_key.write", needsService: true },
);
