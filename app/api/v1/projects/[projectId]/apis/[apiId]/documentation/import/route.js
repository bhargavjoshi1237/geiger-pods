import { route } from "@/lib/control/http.mjs";
import { createControlDb } from "@/lib/control/supabase-db.mjs";
import { withDistributionTables } from "@/lib/control/distribution-db.mjs";
import { importDocumentation } from "@/lib/control/documentation.mjs";

export const runtime = "nodejs";

const deps = {
  createControlDb: (client, options) => withDistributionTables(createControlDb(client, options), client),
};

export const PUT = route(
  async ({ db, actor, projectId, params, body, url, requestId }) =>
    importDocumentation(db, actor, {
      projectId,
      apiId: params.apiId,
      body,
      options: {
        mode: url.searchParams.get("mode") ?? undefined,
        dryRun: url.searchParams.get("dryRun") ?? undefined,
      },
      requestId,
    }),
  { permission: "pods.documentation.write", deps },
);
