import { route } from "@/lib/control/http.mjs";
import { createDomain, listDomains } from "@/lib/control/domains.mjs";

export const runtime = "nodejs";

export const GET = route(
  async ({ db, actor, projectId, url }) =>
    listDomains(db, actor, {
      projectId,
      limit: url.searchParams.get("limit") ?? undefined,
    }),
  { permission: "pods.domain.write" },
);

export const POST = route(
  async ({ db, actor, projectId, body, requestId }) =>
    createDomain(db, actor, { projectId, input: body, requestId }),
  { permission: "pods.domain.write" },
);
