import { route } from "@/lib/control/http.mjs";
import { createServerSupabase } from "@/lib/supabase/server.js";
import { withUsageDb } from "@/lib/control/usage-db.mjs";
import { getUsageKv } from "@/lib/control/usage-kv.mjs";
import { createApiKey, listApiKeys } from "@/lib/control/api-keys.mjs";
import { parseTagFilters } from "@/lib/control/tags.mjs";

export const runtime = "nodejs";

async function usageDb(db) {
  return withUsageDb(db, await createServerSupabase());
}

export const GET = route(
  async ({ db, actor, projectId, url }) =>
    listApiKeys(await usageDb(db), actor, { projectId, tagFilters: parseTagFilters(url.searchParams) }),
  { permission: "pods.api_key.write" },
);

export const POST = route(
  async ({ db, actor, projectId, body, requestId }) =>
    createApiKey(await usageDb(db), actor, {
      projectId,
      name: body?.name,
      description: body?.description,
      customerId: body?.customerId,
      enabled: body?.enabled,
      value: body?.value,
      tags: body?.tags,
      generateDistinctId: body?.generateDistinctId,
      requestId,
    }, { kv: await getUsageKv() }),
  { permission: "pods.api_key.write", needsService: true },
);
