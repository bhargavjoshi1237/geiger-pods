import { route } from "@/lib/control/http.mjs";
import { createServerSupabase } from "@/lib/supabase/server.js";
import { withUsageDb } from "@/lib/control/usage-db.mjs";
import { getUsageKv } from "@/lib/control/usage-kv.mjs";
import { createPlan, listPlans } from "@/lib/control/usage-plans.mjs";

export const runtime = "nodejs";

async function usageDb(db) {
  return withUsageDb(db, await createServerSupabase());
}

export const GET = route(
  async ({ db, actor, projectId }) =>
    listPlans(await usageDb(db), actor, { projectId }),
  { permission: "pods.usage_plan.write" },
);

export const POST = route(
  async ({ db, actor, projectId, body, requestId }) =>
    createPlan(await usageDb(db), actor, {
      projectId,
      name: body?.name,
      description: body?.description,
      throttle: body?.throttle,
      quota: body?.quota,
      tags: body?.tags,
      requestId,
    }, { kv: await getUsageKv() }),
  { permission: "pods.usage_plan.write" },
);
