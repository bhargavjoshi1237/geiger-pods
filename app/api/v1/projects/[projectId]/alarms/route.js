import { route } from "@/lib/control/http.mjs";
import { createControlDb } from "@/lib/control/supabase-db.mjs";
import { withObservabilityTables } from "@/lib/control/observe-db.mjs";
import { listAlarms, createAlarm } from "@/lib/control/alarms.mjs";

export const runtime = "nodejs";

const deps = { createControlDb: (client, opts) => withObservabilityTables(createControlDb(client, opts), client) };

export const GET = route(
  async ({ db, actor, projectId }) => listAlarms(db, actor, { projectId }),
  { deps },
);

export const POST = route(
  async ({ db, actor, projectId, body, requestId }) =>
    createAlarm(db, actor, { projectId, input: body, requestId }),
  { deps },
);
