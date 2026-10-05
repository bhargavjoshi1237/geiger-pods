import { route } from "@/lib/control/http.mjs";
import { createControlDb } from "@/lib/control/supabase-db.mjs";
import { withObservabilityTables } from "@/lib/control/observe-db.mjs";
import { getSink, updateSink, deleteSink } from "@/lib/control/log-sinks.mjs";

export const runtime = "nodejs";

const deps = { createControlDb: (client, opts) => withObservabilityTables(createControlDb(client, opts), client) };

export const GET = route(
  async ({ db, actor, projectId, params }) =>
    getSink(db, actor, { projectId, sinkId: params.sinkId }),
  { deps },
);

export const PATCH = route(
  async ({ db, actor, projectId, params, body, version, requestId }) =>
    updateSink(db, actor, { projectId, sinkId: params.sinkId, patch: body, expectedVersion: version, requestId }),
  { deps },
);

export const DELETE = route(
  async ({ db, actor, projectId, params, requestId }) =>
    deleteSink(db, actor, { projectId, sinkId: params.sinkId, requestId }),
  { deps },
);
