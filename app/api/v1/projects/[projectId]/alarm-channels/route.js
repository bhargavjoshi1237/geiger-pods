import { route } from "@/lib/control/http.mjs";
import { createControlDb } from "@/lib/control/supabase-db.mjs";
import { withObservabilityTables } from "@/lib/control/observe-db.mjs";
import { listChannels, createChannel } from "@/lib/control/alarms.mjs";

export const runtime = "nodejs";

const deps = { createControlDb: (client, opts) => withObservabilityTables(createControlDb(client, opts), client) };

export const GET = route(
  async ({ db, actor, projectId }) => listChannels(db, actor, { projectId }),
  { deps },
);

export const POST = route(
  async ({ db, actor, projectId, body, requestId }) =>
    createChannel(db, actor, { projectId, input: body, requestId }),
  { deps },
);
