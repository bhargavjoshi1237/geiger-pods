import { route } from "@/lib/control/http.mjs";
import { createControlDb } from "@/lib/control/supabase-db.mjs";
import { withObservabilityTables } from "@/lib/control/observe-db.mjs";
import { testSinkDelivery } from "@/lib/control/log-sinks.mjs";

export const runtime = "nodejs";

const deps = { createControlDb: (client, opts) => withObservabilityTables(createControlDb(client, opts), client) };

export const POST = route(
  async ({ db, actor, projectId, params }) =>
    testSinkDelivery(db, actor, { projectId, sinkId: params.sinkId }),
  { deps },
);
