import { route } from "@/lib/control/http.mjs";
import { disassociateWebAcl } from "@/lib/control/waf.mjs";

export const runtime = "nodejs";

export const DELETE = route(
  async ({ db, actor, projectId, params, requestId }) =>
    disassociateWebAcl(db, actor, { projectId, associationId: params.associationId, requestId }),
  { permission: "pods.waf.write" },
);
