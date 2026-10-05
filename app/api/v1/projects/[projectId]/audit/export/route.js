import { resolveActor } from "@/lib/control/actor.mjs";
import { createControlDb } from "@/lib/control/supabase-db.mjs";
import { withObservabilityTables } from "@/lib/control/observe-db.mjs";
import { exportAuditCsv } from "@/lib/control/audit-query.mjs";
import { newRequestId, errorResponse } from "@/lib/control/http.mjs";

export const runtime = "nodejs";

// CSV export cannot go through the JSON `route()` wrapper, so this handler
// repeats its auth flow (cookies → actor → service) and returns `text/csv`.
export async function GET(request, routeContext = {}) {
  const requestId = newRequestId();
  try {
    const params = (await routeContext?.params) ?? {};
    const projectId = params.projectId ?? null;
    const { createServerSupabase } = await import("@/lib/supabase/server.js");
    const supabase = await createServerSupabase();
    const actor = await resolveActor(request, { supabase });
    const db = withObservabilityTables(createControlDb(supabase, {}), supabase);
    const url = new URL(request.url);
    const query = url.searchParams;
    const { csv, count } = await exportAuditCsv(db, actor, {
      projectId,
      filters: {
        ...(query.get("actor") ? { actor: query.get("actor") } : {}),
        ...(query.get("action") ? { action: query.get("action") } : {}),
        ...(query.get("resourceType") ? { resourceType: query.get("resourceType") } : {}),
        ...(query.get("resourceId") ? { resourceId: query.get("resourceId") } : {}),
        ...(query.get("apiId") ? { apiId: query.get("apiId") } : {}),
        ...(query.get("from") ? { from: query.get("from") } : {}),
        ...(query.get("to") ? { to: query.get("to") } : {}),
      },
      limit: query.get("limit") ?? undefined,
    });
    void count;
    return new Response(csv, {
      status: 200,
      headers: {
        "content-type": "text/csv",
        "content-disposition": `attachment; filename="audit-${projectId}.csv"`,
        "x-pods-request-id": requestId,
      },
    });
  } catch (error) {
    return errorResponse(error, requestId);
  }
}
