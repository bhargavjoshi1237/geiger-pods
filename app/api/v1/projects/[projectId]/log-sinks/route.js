import { route } from "@/lib/control/http.mjs";
import { createControlDb } from "@/lib/control/supabase-db.mjs";
import { withObservabilityTables } from "@/lib/control/observe-db.mjs";
import { listSinks, createSink } from "@/lib/control/log-sinks.mjs";

export const runtime = "nodejs";

const deps = { createControlDb: (client, opts) => withObservabilityTables(createControlDb(client, opts), client) };

export const GET = route(
  async ({ db, actor, projectId }) => listSinks(db, actor, { projectId }),
  { deps },
);

export const POST = route(
  async ({ db, actor, projectId, body, requestId }) =>
    createSink(db, actor, { projectId, input: body, requestId }),
  { deps },
);
