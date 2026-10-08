import { route } from "@/lib/control/http.mjs";
import { getIpSet, updateIpSet } from "@/lib/control/waf.mjs";

export const runtime = "nodejs";

export const GET = route(
  async ({ db, actor, projectId, params }) =>
    getIpSet(db, actor, { projectId, setId: params.setId }),
  { permission: "pods.waf.write" },
);

export const PATCH = route(
  async ({ db, actor, projectId, params, body, version, requestId }) =>
    updateIpSet(db, actor, {
      projectId,
      setId: params.setId,
      input: body,
      expectedVersion: version,
      requestId,
    }),
  { permission: "pods.waf.write" },
);
