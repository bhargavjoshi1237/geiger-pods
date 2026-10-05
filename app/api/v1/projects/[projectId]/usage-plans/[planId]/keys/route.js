import { route } from "@/lib/control/http.mjs";
import { createServerSupabase } from "@/lib/supabase/server.js";
import { withUsageDb } from "@/lib/control/usage-db.mjs";
import { getUsageKv } from "@/lib/control/usage-kv.mjs";
import { addKeyToPlan, removeKeyFromPlan } from "@/lib/control/usage-plans.mjs";

export const runtime = "nodejs";

async function usageDb(db) {
  return withUsageDb(db, await createServerSupabase());
}

// POST { keyId } — add a key (same-stage conflict → 409).
// DELETE { keyId } — remove a key.
export const POST = route(
  async ({ db, actor, projectId, params, body, requestId }) =>
    addKeyToPlan(await usageDb(db), actor, {
      projectId,
      planId: params.planId,
      keyId: body?.keyId,
      requestId,
    }, { kv: await getUsageKv() }),
  { permission: "pods.usage_plan.write" },
);

export const DELETE = route(
  async ({ db, actor, projectId, params, body, requestId }) =>
    removeKeyFromPlan(await usageDb(db), actor, {
      projectId,
      planId: params.planId,
      keyId: body?.keyId,
      requestId,
    }, { kv: await getUsageKv() }),
  { permission: "pods.usage_plan.write" },
);
