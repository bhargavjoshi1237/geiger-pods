import { route } from "@/lib/control/http.mjs";
import { associateConnector } from "@/lib/control/domains.mjs";

export const runtime = "nodejs";

export const POST = route(
  async ({ db, actor, projectId, params, body, requestId }) =>
    associateConnector(db, actor, { projectId, domainId: params.domainId, input: body, requestId }),
  { permission: "pods.domain.write" },
);
