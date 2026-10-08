import { route } from "@/lib/control/http.mjs";
import { deleteDomain, getDomain, updateDomain } from "@/lib/control/domains.mjs";

export const runtime = "nodejs";

export const GET = route(
  async ({ db, actor, projectId, params }) =>
    getDomain(db, actor, { projectId, domainId: params.domainId }),
  { permission: "pods.domain.write" },
);

export const PATCH = route(
  async ({ db, actor, projectId, params, body, version, requestId }) =>
    updateDomain(db, actor, {
      projectId,
      domainId: params.domainId,
      patch: body,
      expectedVersion: version,
      requestId,
    }),
  { permission: "pods.domain.write" },
);

export const DELETE = route(
  async ({ db, actor, projectId, params, requestId }) =>
    deleteDomain(db, actor, { projectId, domainId: params.domainId, requestId }),
  { permission: "pods.domain.write" },
);
