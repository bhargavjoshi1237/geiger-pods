import { HttpError } from "@/lib/control/errors.mjs";
import { route } from "@/lib/control/http.mjs";
import { createRoleGrant, listRoleGrants, revokeRoleGrant } from "@/lib/control/role-grants.mjs";

export const runtime = "nodejs";

const OPTIONS = { permission: "pods.role.grant" };

export const GET = route(
  async ({ db, actor, projectId }) => listRoleGrants(db, actor, { projectId }),
  OPTIONS,
);

export const POST = route(
  async ({ db, actor, projectId, body, requestId }) =>
    createRoleGrant(db, actor, {
      projectId,
      userId: body?.userId,
      roleKey: body?.roleKey,
      scope: body?.scope,
      requestId,
    }),
  OPTIONS,
);

export const DELETE = route(
  async ({ db, actor, projectId, url, requestId }) => {
    const grantId = url.searchParams.get("id");
    if (!grantId) throw new HttpError(422, "invalid_input", "Query parameter ?id=<grantId> is required.");
    return revokeRoleGrant(db, actor, { projectId, grantId, requestId });
  },
  OPTIONS,
);
