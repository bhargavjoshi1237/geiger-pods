import { route } from "@/lib/control/http.mjs";
import { verifyDomain } from "@/lib/control/domains.mjs";

export const runtime = "nodejs";

export const POST = route(
  async ({ db, actor, projectId, params, requestId }) =>
    verifyDomain(db, actor, { projectId, domainId: params.domainId, requestId }),
  { permission: "pods.domain.write" },
);
