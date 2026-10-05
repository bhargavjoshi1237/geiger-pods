import { route } from "@/lib/control/http.mjs";
import { createServerSupabase } from "@/lib/supabase/server.js";
import { withUsageDb } from "@/lib/control/usage-db.mjs";
import { getUsageKv } from "@/lib/control/usage-kv.mjs";
import { deletePlan, getPlan, updatePlan } from "@/lib/control/usage-plans.mjs";

export const runtime = "nodejs";

async function usageDb(db) {
  return withUsageDb(db, await createServerSupabase());
}

export const GET = route(
  async ({ db, actor, projectId, params }) =>
    getPlan(await usageDb(db), actor, { projectId, planId: params.planId }),
  { permission: "pods.usage_plan.write" },
);

export const PATCH = route(
  async ({ db, actor, projectId, params, body, version, requestId }) =>
    updatePlan(await usageDb(db), actor, {
      projectId,
      planId: params.planId,
      patch: body ?? {},
      expectedVersion: version,
      requestId,
    }, { kv: await getUsageKv() }),
  { permission: "pods.usage_plan.write" },
);

export const DELETE = route(
  async ({ db, actor, projectId, params, requestId }) =>
    deletePlan(await usageDb(db), actor, {
      projectId,
      planId: params.planId,
      requestId,
    }, { kv: await getUsageKv() }),
  { permission: "pods.usage_plan.write" },
);
