import { route } from "@/lib/control/http.mjs";
import { associateWebAcl } from "@/lib/control/waf.mjs";

export const runtime = "nodejs";

export const POST = route(
  async ({ db, actor, projectId, params, body, requestId }) =>
    associateWebAcl(db, actor, { projectId, webAclId: params.aclId, input: body, requestId }),
  { permission: "pods.waf.write" },
);
