import { route } from "@/lib/control/http.mjs";
import { deleteMapping } from "@/lib/control/domains.mjs";

export const runtime = "nodejs";

export const DELETE = route(
  async ({ db, actor, projectId, params, requestId }) =>
    deleteMapping(db, actor, { projectId, domainId: params.domainId, mappingId: params.mappingId, requestId }),
  { permission: "pods.domain.write" },
);
