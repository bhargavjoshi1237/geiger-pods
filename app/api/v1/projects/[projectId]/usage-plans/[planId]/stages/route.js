import { route } from "@/lib/control/http.mjs";
import { createServerSupabase } from "@/lib/supabase/server.js";
import { withUsageDb } from "@/lib/control/usage-db.mjs";
import { getUsageKv } from "@/lib/control/usage-kv.mjs";
import { addPlanStage, removePlanStage, setPlanMethodThrottles } from "@/lib/control/usage-plans.mjs";

export const runtime = "nodejs";

async function usageDb(db) {
  return withUsageDb(db, await createServerSupabase());
}

// POST { apiId, stage, methodThrottles? } — associate an API stage.
// PATCH { apiId, stage, methodThrottles } — replace per-method throttles.
// DELETE { apiId, stage } — remove the association.
export const POST = route(
  async ({ db, actor, projectId, params, body, requestId }) =>
    addPlanStage(await usageDb(db), actor, {
      projectId,
      planId: params.planId,
      apiId: body?.apiId,
      stage: body?.stage,
      methodThrottles: body?.methodThrottles,
      requestId,
    }, { kv: await getUsageKv() }),
  { permission: "pods.usage_plan.write" },
);

export const PATCH = route(
  async ({ db, actor, projectId, params, body, requestId }) =>
    setPlanMethodThrottles(await usageDb(db), actor, {
      projectId,
      planId: params.planId,
      apiId: body?.apiId,
      stage: body?.stage,
      methodThrottles: body?.methodThrottles,
      requestId,
    }, { kv: await getUsageKv() }),
  { permission: "pods.usage_plan.write" },
);

export const DELETE = route(
  async ({ db, actor, projectId, params, body, requestId }) =>
    removePlanStage(await usageDb(db), actor, {
      projectId,
      planId: params.planId,
      apiId: body?.apiId,
      stage: body?.stage,
      requestId,
    }, { kv: await getUsageKv() }),
  { permission: "pods.usage_plan.write" },
);
