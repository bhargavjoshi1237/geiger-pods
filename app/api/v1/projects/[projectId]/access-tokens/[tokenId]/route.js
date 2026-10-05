import { route } from "@/lib/control/http.mjs";
import { revokeToken } from "@/lib/control/access-tokens.mjs";

export const runtime = "nodejs";

export const DELETE = route(
  async ({ db, actor, projectId, params, requestId }) =>
    revokeToken(db, actor, { projectId, tokenId: params.tokenId, requestId }),
  { permission: "pods.token.write" },
);
