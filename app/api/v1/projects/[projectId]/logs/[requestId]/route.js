import { route } from "@/lib/control/http.mjs";
import { createControlDb } from "@/lib/control/supabase-db.mjs";
import { withObservabilityTables } from "@/lib/control/observe-db.mjs";
import { getRequestDetail } from "@/lib/control/logs.mjs";

export const runtime = "nodejs";

const deps = { createControlDb: (client, opts) => withObservabilityTables(createControlDb(client, opts), client) };

export const GET = route(
  async ({ db, actor, projectId, params }) =>
    getRequestDetail(db, actor, { projectId, requestId: params.requestId }),
  { deps },
);
