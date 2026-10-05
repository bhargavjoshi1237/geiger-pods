import { route } from "@/lib/control/http.mjs";
import { createControlDb } from "@/lib/control/supabase-db.mjs";
import { withObservabilityTables } from "@/lib/control/observe-db.mjs";
import { listAccessLogs, getRequestDetail } from "@/lib/control/logs.mjs";

export const runtime = "nodejs";

const deps = { createControlDb: (client, opts) => withObservabilityTables(createControlDb(client, opts), client) };

export const GET = route(
  async ({ db, actor, projectId, url }) => {
    const query = url.searchParams;
    return listAccessLogs(db, actor, {
      projectId,
      apiId: query.get("apiId"),
      stage: query.get("stage"),
      statusClass: query.get("statusClass"),
      route: query.get("route"),
      requestId: query.get("requestId"),
      sourceIp: query.get("sourceIp"),
      from: query.get("from"),
      to: query.get("to"),
      limit: query.get("limit") ?? undefined,
      cursor: query.get("cursor"),
    });
  },
  { deps },
);
