import { route } from "@/lib/control/http.mjs";
import { deleteRoutingRule } from "@/lib/control/domains.mjs";

export const runtime = "nodejs";

export const DELETE = route(
  async ({ db, actor, projectId, params, requestId }) =>
    deleteRoutingRule(db, actor, { projectId, domainId: params.domainId, ruleId: params.ruleId, requestId }),
  { permission: "pods.domain.write" },
);
