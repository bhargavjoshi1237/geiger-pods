import { route } from "@/lib/control/http.mjs";
import { listAuditEvents } from "@/lib/control/audit.mjs";

export const runtime = "nodejs";

export const GET = route(
  async ({ db, actor, projectId, url }) => {
    const query = url.searchParams;
    return listAuditEvents(db, actor, {
      projectId,
      filters: {
        ...(query.get("resourceType") ? { resourceType: query.get("resourceType") } : {}),
        ...(query.get("resourceId") ? { resourceId: query.get("resourceId") } : {}),
        ...(query.get("actor") ? { actor: query.get("actor") } : {}),
        // S10 §8 additions (passed through; the S02 service ignores unknown
        // keys only when the db port does — the S10 mixin handles action/apiId).
        ...(query.get("action") ? { action: query.get("action") } : {}),
        ...(query.get("apiId") ? { apiId: query.get("apiId") } : {}),
        ...(query.get("from") ? { from: query.get("from") } : {}),
        ...(query.get("to") ? { to: query.get("to") } : {}),
      },
      limit: query.get("limit") ?? undefined,
      cursor: query.get("cursor"),
    });
  },
  { permission: "pods.audit.view" },
);
