import { route } from "@/lib/control/http.mjs";
import { reorderRoutingRules } from "@/lib/control/domains.mjs";

export const runtime = "nodejs";

export const POST = route(
  async ({ db, actor, projectId, params, body, requestId }) =>
    reorderRoutingRules(db, actor, {
      projectId,
      domainId: params.domainId,
      ruleIds: body?.ruleIds ?? [],
      requestId,
    }),
  { permission: "pods.domain.write" },
);
