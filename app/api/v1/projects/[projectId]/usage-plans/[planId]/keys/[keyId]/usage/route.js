import { route } from "@/lib/control/http.mjs";
import { createServerSupabase } from "@/lib/supabase/server.js";
import { withUsageDb } from "@/lib/control/usage-db.mjs";
import { getUsageKv } from "@/lib/control/usage-kv.mjs";
import { updateUsage } from "@/lib/control/usage-plans.mjs";

export const runtime = "nodejs";

// AWS UpdateUsage: PATCH { op: extend|reset|set, value? }.
export const PATCH = route(
  async ({ db, actor, projectId, params, body, requestId }) =>
    updateUsage(await withUsageDb(db, await createServerSupabase()), actor, {
      projectId,
      planId: params.planId,
      keyId: params.keyId,
      op: body?.op,
      value: body?.value,
      requestId,
    }, { kv: await getUsageKv() }),
  { permission: "pods.usage_plan.write" },
);
