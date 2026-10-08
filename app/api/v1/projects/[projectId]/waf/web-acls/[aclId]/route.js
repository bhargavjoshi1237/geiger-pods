import { route } from "@/lib/control/http.mjs";
import { getWebAcl, updateWebAcl } from "@/lib/control/waf.mjs";

export const runtime = "nodejs";

export const GET = route(
  async ({ db, actor, projectId, params }) =>
    getWebAcl(db, actor, { projectId, aclId: params.aclId }),
  { permission: "pods.waf.write" },
);

export const PATCH = route(
  async ({ db, actor, projectId, params, body, version, requestId }) =>
    updateWebAcl(db, actor, {
      projectId,
      aclId: params.aclId,
      input: body,
      expectedVersion: version,
      requestId,
    }),
  { permission: "pods.waf.write" },
);
