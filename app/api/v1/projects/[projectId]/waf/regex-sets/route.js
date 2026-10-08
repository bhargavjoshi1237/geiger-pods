import { route } from "@/lib/control/http.mjs";
import { createRegexSet, listRegexSets } from "@/lib/control/waf.mjs";

export const runtime = "nodejs";

export const GET = route(
  async ({ db, actor, projectId }) => listRegexSets(db, actor, { projectId }),
  { permission: "pods.waf.write" },
);

export const POST = route(
  async ({ db, actor, projectId, body, requestId }) =>
    createRegexSet(db, actor, { projectId, input: body, requestId }),
  { permission: "pods.waf.write" },
);
