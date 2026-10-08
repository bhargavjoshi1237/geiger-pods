import { route } from "@/lib/control/http.mjs";
import { getRegexSet } from "@/lib/control/waf.mjs";

export const runtime = "nodejs";

export const GET = route(
  async ({ db, actor, projectId, params }) =>
    getRegexSet(db, actor, { projectId, setId: params.setId }),
  { permission: "pods.waf.write" },
);
