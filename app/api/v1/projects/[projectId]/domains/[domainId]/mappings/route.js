import { route } from "@/lib/control/http.mjs";
import { createMapping, listMappings } from "@/lib/control/domains.mjs";

export const runtime = "nodejs";

export const GET = route(
  async ({ db, actor, projectId, params }) =>
    listMappings(db, actor, { projectId, domainId: params.domainId }),
  { permission: "pods.domain.write" },
);

export const POST = route(
  async ({ db, actor, projectId, params, body, requestId }) =>
    createMapping(db, actor, { projectId, domainId: params.domainId, input: body, requestId }),
  { permission: "pods.domain.write" },
);
