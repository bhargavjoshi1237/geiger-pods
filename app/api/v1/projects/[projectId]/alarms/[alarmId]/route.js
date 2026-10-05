import { route } from "@/lib/control/http.mjs";
import { createControlDb } from "@/lib/control/supabase-db.mjs";
import { withObservabilityTables } from "@/lib/control/observe-db.mjs";
import { getAlarm, updateAlarm, deleteAlarm } from "@/lib/control/alarms.mjs";

export const runtime = "nodejs";

const deps = { createControlDb: (client, opts) => withObservabilityTables(createControlDb(client, opts), client) };

export const GET = route(
  async ({ db, actor, projectId, params }) =>
    getAlarm(db, actor, { projectId, alarmId: params.alarmId }),
  { deps },
);

export const PATCH = route(
  async ({ db, actor, projectId, params, body, version, requestId }) =>
    updateAlarm(db, actor, { projectId, alarmId: params.alarmId, patch: body, expectedVersion: version, requestId }),
  { deps },
);

export const DELETE = route(
  async ({ db, actor, projectId, params, requestId }) =>
    deleteAlarm(db, actor, { projectId, alarmId: params.alarmId, requestId }),
  { deps },
);
