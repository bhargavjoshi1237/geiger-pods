import { route } from "@/lib/control/http.mjs";
import { createControlDb } from "@/lib/control/supabase-db.mjs";
import { withAuthTables } from "@/lib/control/auth-db.mjs";
import { simulateResourcePolicy } from "@/lib/control/resource-policies.mjs";

export const runtime = "nodejs";

const deps = {
  createControlDb: (client, options) => withAuthTables(createControlDb(client, options), client),
};

export const POST = route(
  async ({ db, actor, projectId, params, body }) => simulateResourcePolicy(db, actor, {
    projectId,
    apiId: params.apiId,
    methodArn: body?.methodArn,
    sourceIp: body?.sourceIp ?? "",
    principalArn: body?.principalArn ?? null,
  }),
  { deps },
);
