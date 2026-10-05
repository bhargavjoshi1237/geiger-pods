import { route } from "@/lib/control/http.mjs";
import { createControlDb } from "@/lib/control/supabase-db.mjs";
import { withObservabilityTables } from "@/lib/control/observe-db.mjs";
import { deleteChannel } from "@/lib/control/alarms.mjs";

export const runtime = "nodejs";

const deps = { createControlDb: (client, opts) => withObservabilityTables(createControlDb(client, opts), client) };

export const DELETE = route(
  async ({ db, actor, projectId, params, requestId }) =>
    deleteChannel(db, actor, { projectId, channelId: params.channelId, requestId }),
  { deps },
);
