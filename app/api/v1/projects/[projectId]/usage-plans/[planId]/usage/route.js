import { route } from "@/lib/control/http.mjs";
import { createServerSupabase } from "@/lib/supabase/server.js";
import { withUsageDb } from "@/lib/control/usage-db.mjs";
import { getUsageKv } from "@/lib/control/usage-kv.mjs";
import { getUsage } from "@/lib/control/usage-plans.mjs";

export const runtime = "nodejs";

// AWS-shaped usage report: ?keyId=&startDate=YYYY-MM-DD&endDate=YYYY-MM-DD.
// Today's numbers are live KV counters; past days come from usage_daily.
export const GET = route(
  async ({ db, actor, projectId, params, url }) =>
    getUsage(await withUsageDb(db, await createServerSupabase()), actor, {
      projectId,
      planId: params.planId,
      keyId: url.searchParams.get("keyId"),
      startDate: url.searchParams.get("startDate"),
      endDate: url.searchParams.get("endDate"),
    }, { kv: await getUsageKv() }),
  { permission: "pods.usage.view" },
);
